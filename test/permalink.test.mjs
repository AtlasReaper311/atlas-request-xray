import assert from "node:assert/strict";
import test from "node:test";

import { encodeState, decodeState } from "../src/permalink.js";
import { normaliseConfig, TIMEOUT_CHOICES_MS, simulateRequest } from "../src/engine.js";
import { PRESETS } from "../src/presets.js";

function everyConfiguration() {
  const all = [];
  for (const cacheHit of [true, false]) {
    for (const staleCache of [true, false]) {
      for (const rateLimit of [true, false]) {
        for (const serviceError of [true, false]) {
          for (const jitter of [true, false]) {
            for (const retries of [0, 1, 2, 3]) {
              for (const timeoutMs of TIMEOUT_CHOICES_MS) {
                all.push({ cacheHit, staleCache, rateLimit, serviceError, jitter, retries, timeoutMs });
              }
            }
          }
        }
      }
    }
  }
  return all;
}

test("every configuration survives a round trip through the query string", () => {
  for (const config of everyConfiguration()) {
    const restored = decodeState(encodeState({ config }));
    assert.deepEqual(restored.config, normaliseConfig(config));
    assert.equal(restored.compare, false);
    assert.equal(restored.compareConfig, null);
  }
});

test("a round trip reproduces the identical trace", () => {
  for (const preset of PRESETS) {
    const before = simulateRequest(preset.config);
    const after = simulateRequest(decodeState(encodeState({ config: preset.config })).config);
    assert.deepEqual(after.hops, before.hops);
    assert.equal(after.summary.totalLatencyMs, before.summary.totalLatencyMs);
  }
});

test("a pinned comparison round trips alongside the current configuration", () => {
  const config = { cacheHit: false, staleCache: false, rateLimit: false, retries: 2, timeoutMs: 100, serviceError: false, jitter: true };
  const compareConfig = { cacheHit: true, staleCache: true, rateLimit: false, retries: 0, timeoutMs: 500, serviceError: false, jitter: false };

  const restored = decodeState(encodeState({ config, compare: true, compareConfig }));
  assert.equal(restored.compare, true);
  assert.deepEqual(restored.config, normaliseConfig(config));
  assert.deepEqual(restored.compareConfig, normaliseConfig(compareConfig));
});

test("an empty query string yields the default configuration", () => {
  const restored = decodeState("");
  assert.deepEqual(restored.config, normaliseConfig({}));
  assert.equal(restored.compare, false);
});

test("a hand-edited query string degrades to the nearest legal experiment", () => {
  const restored = decodeState("?n=99&t=7&c=maybe&e=1");
  assert.equal(restored.config.retries, 3);
  assert.equal(restored.config.timeoutMs, 250);
  assert.equal(restored.config.cacheHit, normaliseConfig({}).cacheHit);
  assert.equal(restored.config.serviceError, true);
});

test("unrelated query parameters are ignored rather than breaking the read", () => {
  const restored = decodeState("?utm_source=elsewhere&n=1&e=1&c=0");
  assert.equal(restored.config.retries, 1);
  assert.equal(restored.config.serviceError, true);
  assert.equal(restored.config.cacheHit, false);
});

test("the current and pinned configurations never share a query key", () => {
  const query = encodeState({
    config: { retries: 1 },
    compare: true,
    compareConfig: { retries: 3 },
  });
  const keys = [...new URLSearchParams(query).keys()];
  assert.equal(new Set(keys).size, keys.length, "a duplicated key would let one configuration overwrite the other");
});

test("encoding is stable, so the same configuration always produces the same link", () => {
  const config = { cacheHit: false, retries: 2, timeoutMs: 100, serviceError: true };
  assert.equal(encodeState({ config }), encodeState({ config }));
  assert.equal(encodeState({ config }), encodeState({ config: normaliseConfig(config) }));
});

test("default state can be omitted so the canonical landing URL stays clean", () => {
  assert.equal(encodeState({ config: {}, omitDefault: true }), "");
  assert.notEqual(encodeState({ config: { retries: 1 }, omitDefault: true }), "");
});
