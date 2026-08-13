import assert from "node:assert/strict";
import test from "node:test";

import { easeInOut, backOut, easeForHop, OUTCOME_STATE, TIME_SCALE } from "../src/playback.js";
import { simulateRequest, TIMEOUT_CHOICES_MS } from "../src/engine.js";
import { PRESETS, presetById } from "../src/presets.js";

function sample(ease, steps = 200) {
  return Array.from({ length: steps + 1 }, (_, index) => ease(index / steps));
}

test("both easings start at 0 and finish at 1", () => {
  for (const ease of [easeInOut, backOut]) {
    assert.equal(ease(0), 0);
    assert.ok(Math.abs(ease(1) - 1) < 1e-9);
  }
});

test("ordinary travel never overshoots its target", () => {
  for (const value of sample(easeInOut)) {
    assert.ok(value >= 0 && value <= 1, `easeInOut left the 0 to 1 range at ${value}`);
  }
});

test("the retry bounce overshoots, which is the whole point of it", () => {
  const values = sample(backOut);
  assert.ok(Math.max(...values) > 1, "backOut must travel past its target");
  assert.ok(Math.max(...values) < 1.15, "the overshoot should read as a recoil, not a slingshot");
});

test("the overshoot is applied to retry hops and nothing else", () => {
  const { hops } = simulateRequest(presetById("retry-storm").config);
  const bounced = hops.filter((hop) => easeForHop(hop) === backOut);
  const plain = hops.filter((hop) => easeForHop(hop) === easeInOut);

  assert.deepEqual(
    bounced.map((hop) => `${hop.layer}:${hop.attempt}`),
    ["api:2", "service:2", "api:3", "service:3", "api:3"],
    "only the api and service hops after the first attempt should recoil",
  );
  assert.ok(plain.every((hop) => hop.attempt === 1));
});

test("a run with no retries never uses the overshoot", () => {
  const { hops } = simulateRequest(presetById("healthy-baseline").config);
  assert.ok(hops.every((hop) => easeForHop(hop) === easeInOut));
});

test("every outcome the engine can emit has a status colour", () => {
  const emitted = new Set();
  for (const cacheHit of [true, false]) {
    for (const staleCache of [true, false]) {
      for (const rateLimit of [true, false]) {
        for (const serviceError of [true, false]) {
          for (const retries of [0, 1, 2, 3]) {
            for (const timeoutMs of TIMEOUT_CHOICES_MS) {
              for (const jitter of [true, false]) {
                const { hops } = simulateRequest({
                  cacheHit,
                  staleCache,
                  rateLimit,
                  serviceError,
                  retries,
                  timeoutMs,
                  jitter,
                });
                for (const hop of hops) emitted.add(hop.outcome);
              }
            }
          }
        }
      }
    }
  }
  for (const outcome of emitted) {
    assert.ok(OUTCOME_STATE[outcome], `outcome '${outcome}' would render without a status colour`);
    assert.ok(["ok", "warn", "fail"].includes(OUTCOME_STATE[outcome]));
  }
});

test("amber is never a resting state for a hop that simply passed the request on", () => {
  for (const outcome of ["sent", "forwarded", "routed", "dispatched", "called", "hit", "read", "returned", "rendered"]) {
    assert.equal(OUTCOME_STATE[outcome], "ok", `${outcome} should settle green`);
  }
  for (const outcome of ["error", "timeout", "exhausted", "failed", "rate_limited"]) {
    assert.equal(OUTCOME_STATE[outcome], "fail", `${outcome} should settle red`);
  }
  for (const outcome of ["retrying", "stale", "miss"]) {
    assert.equal(OUTCOME_STATE[outcome], "warn", `${outcome} should settle amber`);
  }
});

test("playback duration stays proportional to real latency", () => {
  for (const preset of PRESETS) {
    const { hops, summary } = simulateRequest(preset.config);
    const wallMs = hops.reduce((total, hop) => total + hop.latencyMs * TIME_SCALE, 0);
    assert.equal(wallMs, summary.totalLatencyMs * TIME_SCALE);
    // A run should be watchable rather than either instant or tedious.
    assert.ok(wallMs >= 100 && wallMs <= 4000, `${preset.id} plays for ${wallMs}ms`);
  }
});
