import assert from "node:assert/strict";
import test from "node:test";
import { parseStickybarConfig } from "../src/stickybar-config.ts";

test("stickybar defaults to the single built-in layout", () => {
  const config = parseStickybarConfig(undefined);
  assert.deepEqual(config.top, ["git", "context_pct", "token_in", "token_out", "cost", "time_spent"]);
  assert.deepEqual(config.bottom, ["model", "thinking", "path", "extension_statuses"]);
  assert.equal(config.vibe.theme, null);
  assert.equal(config.vibe.lookback, 30);
  assert.equal(config.vibe.printing, true);
});

test("custom items are placed directly in the configured line order", () => {
  const config = parseStickybarConfig({
    top: ["model", "custom:ci", "git", "custom:missing"],
    bottom: ["git", "context_pct", "custom:ci"],
    customItems: [{ id: "ci", statusKey: "ci-status" }],
  });
  assert.deepEqual(config.top, ["model", "custom:ci", "git"]);
  assert.deepEqual(config.bottom, ["context_pct"]);
});

test("vibe settings are nested under stickybar and validated", () => {
  const config = parseStickybarConfig({
    vibe: { theme: "pirate", mode: "file", rainbow: true, printing: false, model: "openai/gpt-test", refreshInterval: 5, lookback: 10 },
  });
  assert.equal(config.vibe.theme, "pirate");
  assert.equal(config.vibe.mode, "file");
  assert.equal(config.vibe.rainbow, true);
  assert.equal(config.vibe.printing, false);
  assert.equal(config.vibe.model, "openai/gpt-test");
  assert.equal(config.vibe.refreshInterval, 5);
  assert.equal(config.vibe.lookback, 10);
});

test("vibe lookback falls back to default on invalid values", () => {
  const negative = parseStickybarConfig({ vibe: { lookback: -5 } });
  assert.equal(negative.vibe.lookback, 0);
  const invalid = parseStickybarConfig({ vibe: { lookback: "a lot" } });
  assert.equal(invalid.vibe.lookback, 30);
});
