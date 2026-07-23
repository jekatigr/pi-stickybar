import assert from "node:assert/strict";
import test from "node:test";
import { readCoreContextUsage } from "../src/context-usage.ts";

test("preserves Pi's unknown context usage after compaction", () => {
  const context = {
    getContextUsage: () => ({ tokens: null, contextWindow: 200_000, percent: null }),
  };

  assert.deepEqual(readCoreContextUsage(context), {
    contextTokens: null,
    contextWindow: 200_000,
    contextPercent: null,
  });
});

test("calculates context percentage when Pi omits it", () => {
  const context = {
    getContextUsage: () => ({ tokens: 40_000, contextWindow: 200_000, percent: null }),
  };

  assert.deepEqual(readCoreContextUsage(context), {
    contextTokens: 40_000,
    contextWindow: 200_000,
    contextPercent: 20,
  });
});
