import assert from "node:assert/strict";
import test from "node:test";

import {
  simulateRequest,
  normaliseConfig,
  LAYERS,
  LAYER_SWITCHES,
  TIMEOUT_CHOICES_MS,
  DEFAULT_BUDGET_MS,
} from "../src/engine.js";
import { explanationIds } from "../src/explanations.js";
import { PRESETS, presetById } from "../src/presets.js";

/**
 * The canonical fixture. A three-attempt retry storm against an injected
 * service error costs exactly 290ms across three downstream calls, terminates
 * at the api layer with outcome `exhausted`, and generates no return trip.
 * This is the contract the whole tool rests on; if it moves, every number in
 * the README and the documentation is wrong.
 */
const RETRY_STORM_FIXTURE = [
  { layer: "browser", attempt: 1, outcome: "sent", latencyMs: 5 },
  { layer: "edge", attempt: 1, outcome: "forwarded", latencyMs: 10 },
  { layer: "router", attempt: 1, outcome: "routed", latencyMs: 5 },
  { layer: "api", attempt: 1, outcome: "dispatched", latencyMs: 20 },
  { layer: "service", attempt: 1, outcome: "error", latencyMs: 40 },
  { layer: "api", attempt: 2, outcome: "retrying", latencyMs: 50 },
  { layer: "service", attempt: 2, outcome: "error", latencyMs: 40 },
  { layer: "api", attempt: 3, outcome: "retrying", latencyMs: 80 },
  { layer: "service", attempt: 3, outcome: "error", latencyMs: 40 },
  { layer: "api", attempt: 3, outcome: "exhausted", latencyMs: 0 },
];

test("the retry storm fixture reproduces hop for hop", () => {
  const { hops, summary } = simulateRequest(presetById("retry-storm").config);

  const shape = hops.map(({ layer, attempt, outcome, latencyMs }) => ({ layer, attempt, outcome, latencyMs }));
  assert.deepEqual(shape, RETRY_STORM_FIXTURE);

  assert.equal(summary.totalLatencyMs, 290);
  assert.equal(summary.downstreamCalls, 3);
  assert.equal(summary.attempts, 3);
  assert.equal(summary.outcome, "exhausted");
  assert.equal(summary.terminalLayer, "api");
  assert.equal(summary.explanationId, "retry-storm");
});

test("an exhausted request generates no return trip", () => {
  const { hops } = simulateRequest(presetById("retry-storm").config);
  const returning = hops.filter((hop) => ["returned", "rendered"].includes(hop.outcome));
  assert.equal(returning.length, 0, "a failed request must stop where the failure is owned");
});

test("every hop carries a note", () => {
  for (const preset of PRESETS) {
    const { hops } = simulateRequest(preset.config);
    for (const hop of hops) {
      assert.ok(hop.note && hop.note.length > 0, `${preset.id}: ${hop.layer}/${hop.outcome} has no note`);
    }
  }
});

test("preset totals are the exact numbers the documentation states", () => {
  const expected = {
    "healthy-baseline": { totalLatencyMs: 101, downstreamCalls: 1, status: "ok", explanationId: "healthy-baseline" },
    "retry-storm": { totalLatencyMs: 290, downstreamCalls: 3, status: "exhausted", explanationId: "retry-storm" },
    "cache-stampede": { totalLatencyMs: 470, downstreamCalls: 3, status: "exhausted", explanationId: "cache-stampede" },
    "rate-limited": { totalLatencyMs: 20, downstreamCalls: 0, status: "rate limited", explanationId: "rate-limited" },
    "cascading-timeout": {
      totalLatencyMs: 510,
      downstreamCalls: 4,
      status: "exhausted",
      explanationId: "cascading-timeout",
    },
  };

  for (const preset of PRESETS) {
    const { summary } = simulateRequest(preset.config);
    assert.deepEqual(
      {
        totalLatencyMs: summary.totalLatencyMs,
        downstreamCalls: summary.downstreamCalls,
        status: summary.status,
        explanationId: summary.explanationId,
      },
      expected[preset.id],
      `preset ${preset.id} drifted`,
    );
  }
});

test("a healthy request returns through the router, the edge, and the browser", () => {
  const { hops, summary } = simulateRequest(presetById("healthy-baseline").config);
  const tail = hops.slice(-3).map((hop) => `${hop.layer}:${hop.outcome}`);
  assert.deepEqual(tail, ["router:returned", "edge:returned", "browser:rendered"]);
  assert.equal(summary.terminalLayer, "browser");
  assert.equal(summary.status, "ok");
});

test("a rate limited request never reaches the api", () => {
  const { hops, summary } = simulateRequest({ rateLimit: true, retries: 3 });
  assert.deepEqual(hops.map((hop) => hop.layer), ["browser", "edge", "router"]);
  assert.equal(summary.downstreamCalls, 0);
  assert.equal(summary.attempts, 0);
  assert.equal(summary.status, "rate limited");
});

test("retries produce one downstream call per attempt", () => {
  for (const retries of [0, 1, 2, 3]) {
    const { summary } = simulateRequest({ cacheHit: false, serviceError: true, retries });
    assert.equal(summary.attempts, retries + 1);
    assert.equal(summary.downstreamCalls, retries + 1);
  }
});

test("no retry budget reports a single failure rather than exhaustion", () => {
  const { summary } = simulateRequest({ serviceError: true, retries: 0 });
  assert.equal(summary.outcome, "failed");
  assert.equal(summary.explanationId, "single-failure");
});

test("a stale cache entry is a success that is flagged, not a failure", () => {
  const { summary } = simulateRequest({ cacheHit: true, staleCache: true });
  assert.equal(summary.status, "ok");
  assert.equal(summary.servedFrom, "stale-cache");
  assert.equal(summary.explanationId, "stale-cache-served");
});

test("a cache miss reads the database when the deadline allows it", () => {
  const { hops, summary } = simulateRequest({ cacheHit: false, timeoutMs: 250 });
  assert.ok(hops.some((hop) => hop.layer === "cache" && hop.outcome === "miss"));
  assert.ok(hops.some((hop) => hop.layer === "database" && hop.outcome === "read"));
  assert.equal(summary.servedFrom, "database");
  assert.equal(summary.explanationId, "cache-miss-path");
});

test("a deadline shorter than the work truncates the overrunning hop", () => {
  const { hops } = simulateRequest({ cacheHit: false, timeoutMs: 100, retries: 0 });
  const database = hops.find((hop) => hop.layer === "database");
  assert.equal(database.outcome, "timeout");
  // service 40 plus cache 5 leaves 55ms of the 100ms deadline for the query.
  assert.equal(database.latencyMs, 55);
});

test("no attempt can ever exceed its own deadline", () => {
  for (const timeoutMs of TIMEOUT_CHOICES_MS) {
    for (const cacheHit of [true, false]) {
      const { hops } = simulateRequest({ cacheHit, timeoutMs, retries: 3, jitter: true });
      const perAttempt = new Map();
      for (const hop of hops) {
        if (!["service", "cache", "database"].includes(hop.layer)) continue;
        perAttempt.set(hop.attempt, (perAttempt.get(hop.attempt) ?? 0) + hop.latencyMs);
      }
      for (const [attempt, spent] of perAttempt) {
        assert.ok(spent <= timeoutMs, `timeout ${timeoutMs}ms, attempt ${attempt} spent ${spent}ms`);
      }
    }
  }
});

test("latency variance is deterministic for a given configuration", () => {
  const config = { cacheHit: false, retries: 2, timeoutMs: 500, jitter: true };
  const first = simulateRequest(config);
  const second = simulateRequest(config);
  assert.deepEqual(first.hops, second.hops);
  assert.equal(first.summary.totalLatencyMs, second.summary.totalLatencyMs);
});

test("latency variance only ever adds time", () => {
  const config = { cacheHit: false, retries: 1, timeoutMs: 500 };
  const still = simulateRequest({ ...config, jitter: false });
  const varied = simulateRequest({ ...config, jitter: true });
  assert.ok(
    varied.summary.totalLatencyMs >= still.summary.totalLatencyMs,
    "variance must not make a request faster than its baseline",
  );
});

test("latency variance changes the trace it is applied to", () => {
  const config = { cacheHit: false, retries: 1, timeoutMs: 500 };
  const still = simulateRequest({ ...config, jitter: false });
  const varied = simulateRequest({ ...config, jitter: true });
  assert.notEqual(varied.summary.totalLatencyMs, still.summary.totalLatencyMs);
});

test("hand-edited configurations are clamped rather than rejected", () => {
  const config = normaliseConfig({ retries: 99, timeoutMs: 7, cacheHit: "yes", jitter: "no", staleCache: null });
  assert.equal(config.retries, 3);
  assert.equal(config.timeoutMs, 250);
  assert.equal(config.cacheHit, true);
  assert.equal(config.jitter, false);
  assert.equal(config.staleCache, false);

  const negative = normaliseConfig({ retries: -4 });
  assert.equal(negative.retries, 0);
});

test("every hop names a real layer and a positive attempt", () => {
  for (const preset of PRESETS) {
    const { hops } = simulateRequest(preset.config);
    for (const hop of hops) {
      assert.ok(LAYERS.includes(hop.layer), `unknown layer ${hop.layer}`);
      assert.ok(Number.isInteger(hop.attempt) && hop.attempt >= 1);
      assert.ok(Number.isInteger(hop.latencyMs) && hop.latencyMs >= 0);
    }
  }
});

test("the summary total always equals the sum of its hops", () => {
  for (const retries of [0, 1, 2, 3]) {
    for (const timeoutMs of TIMEOUT_CHOICES_MS) {
      for (const jitter of [false, true]) {
        const { hops, summary } = simulateRequest({ cacheHit: false, retries, timeoutMs, jitter });
        const sum = hops.reduce((total, hop) => total + hop.latencyMs, 0);
        assert.equal(summary.totalLatencyMs, sum);
      }
    }
  }
});

test("the over-budget flag matches the default budget", () => {
  const under = simulateRequest(presetById("healthy-baseline").config);
  assert.equal(under.summary.overBudget, false);
  assert.equal(under.summary.budgetMs, DEFAULT_BUDGET_MS);

  const over = simulateRequest(presetById("cascading-timeout").config);
  assert.equal(over.summary.overBudget, true);
  assert.ok(over.summary.totalLatencyMs > DEFAULT_BUDGET_MS);
});

test("every switch is owned by exactly one layer", () => {
  const owned = Object.values(LAYER_SWITCHES).flat();
  assert.equal(owned.length, 7, "there are seven switches");
  assert.equal(new Set(owned).size, 7, "no switch is claimed by two layers");
  assert.deepEqual(Object.keys(LAYER_SWITCHES).sort(), [...LAYERS].sort());
  assert.deepEqual(LAYER_SWITCHES.browser, []);
  assert.deepEqual(LAYER_SWITCHES.database, []);
});

test("every explanation the tool can produce comes from the template library", () => {
  const known = new Set(explanationIds());
  const seen = new Set();
  for (const cacheHit of [true, false]) {
    for (const staleCache of [true, false]) {
      for (const rateLimit of [true, false]) {
        for (const serviceError of [true, false]) {
          for (const retries of [0, 1, 2, 3]) {
            for (const timeoutMs of TIMEOUT_CHOICES_MS) {
              for (const jitter of [true, false]) {
                const { summary } = simulateRequest({
                  cacheHit,
                  staleCache,
                  rateLimit,
                  serviceError,
                  retries,
                  timeoutMs,
                  jitter,
                });
                assert.ok(known.has(summary.explanationId), `unknown template ${summary.explanationId}`);
                assert.ok(summary.explanation.length > 0);
                seen.add(summary.explanationId);
              }
            }
          }
        }
      }
    }
  }
  assert.ok(!seen.has("unclassified"), "no reachable configuration should fall through to the fallback template");
});
