import assert from "node:assert/strict";
import test from "node:test";
import { getStickybarArgumentCompletions } from "../src/stickybar-completions.ts";

test("empty prefix returns vibe suggestion", () => {
  const result = getStickybarArgumentCompletions("");
  assert.ok(result);
  assert.equal(result.length, 1);
  assert.equal(result[0].value, "vibe");
});

test("space-only prefix returns vibe suggestion", () => {
  const result = getStickybarArgumentCompletions(" ");
  assert.ok(result);
  assert.equal(result.length, 1);
  assert.equal(result[0].value, "vibe");
});

test("partial first word 'vi' matches vibe", () => {
  const result = getStickybarArgumentCompletions("vi");
  assert.ok(result);
  assert.equal(result.length, 1);
  assert.equal(result[0].value, "vibe");
});

test("non-vibe first word returns null", () => {
  const result = getStickybarArgumentCompletions("foo bar");
  assert.equal(result, null);
});

test("'vibe' without trailing space matches vibe", () => {
  const result = getStickybarArgumentCompletions("vibe");
  assert.ok(result);
  assert.equal(result.length, 1);
  assert.equal(result[0].value, "vibe");
});

test("'vibe ' with trailing space returns all vibe actions", () => {
  const result = getStickybarArgumentCompletions("vibe ");
  assert.ok(result);
  assert.equal(result.length, 6); // off, rainbow, printing, mode, model, generate
  const values = result.map((r) => r.value);
  assert.ok(values.includes("off"));
  assert.ok(values.includes("rainbow"));
  assert.ok(values.includes("printing"));
  assert.ok(values.includes("mode"));
  assert.ok(values.includes("model"));
  assert.ok(values.includes("generate"));
});

test("partial action word 'vibe r' matches rainbow from VIBE_ACTIONS", () => {
  const result = getStickybarArgumentCompletions("vibe r");
  assert.ok(result);
  assert.equal(result.length, 1);
  assert.equal(result[0].value, "rainbow");
});

test("partial action word 'vibe m' matches mode and model from VIBE_ACTIONS", () => {
  const result = getStickybarArgumentCompletions("vibe m");
  assert.ok(result);
  assert.equal(result.length, 2);
  const values = result.map((r) => r.value);
  assert.ok(values.includes("mode"));
  assert.ok(values.includes("model"));
});

test("partial action word 'vibe g' matches generate from VIBE_ACTIONS", () => {
  const result = getStickybarArgumentCompletions("vibe g");
  assert.ok(result);
  assert.equal(result.length, 1);
  assert.equal(result[0].value, "generate");
});

test("partial action word 'vibe o' matches off from VIBE_ACTIONS", () => {
  const result = getStickybarArgumentCompletions("vibe o");
  assert.ok(result);
  assert.equal(result.length, 1);
  assert.equal(result[0].value, "off");
});

test("complete action 'vibe rainbow' without trailing space still matches", () => {
  const result = getStickybarArgumentCompletions("vibe rainbow");
  assert.ok(result);
  assert.equal(result.length, 1);
  assert.equal(result[0].value, "rainbow");
});

test("'vibe rainbow ' with trailing space returns on/off", () => {
  const result = getStickybarArgumentCompletions("vibe rainbow ");
  assert.ok(result);
  assert.equal(result.length, 2);
  const values = result.map((r) => r.value);
  assert.ok(values.includes("on"));
  assert.ok(values.includes("off"));
});

test("'vibe rainbow o' matches on and off", () => {
  const result = getStickybarArgumentCompletions("vibe rainbow o");
  assert.ok(result);
  assert.equal(result.length, 2);
  const values = result.map((r) => r.value);
  assert.ok(values.includes("on"));
  assert.ok(values.includes("off"));
});

test("'vibe rainbow on' without trailing space matches on", () => {
  const result = getStickybarArgumentCompletions("vibe rainbow on");
  assert.ok(result);
  assert.equal(result.length, 1);
  assert.equal(result[0].value, "on");
});

test("'vibe printing ' with trailing space returns on/off", () => {
  const result = getStickybarArgumentCompletions("vibe printing ");
  assert.ok(result);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((item) => item.value), ["on", "off"]);
});

test("'vibe mode ' with trailing space returns generate/file", () => {
  const result = getStickybarArgumentCompletions("vibe mode ");
  assert.ok(result);
  assert.equal(result.length, 2);
  const values = result.map((r) => r.value);
  assert.ok(values.includes("generate"));
  assert.ok(values.includes("file"));
});

test("'vibe mode f' matches file", () => {
  const result = getStickybarArgumentCompletions("vibe mode f");
  assert.ok(result);
  assert.equal(result.length, 1);
  assert.equal(result[0].value, "file");
});

test("'vibe model ' returns provider/model hint", () => {
  const result = getStickybarArgumentCompletions("vibe model ");
  assert.ok(result);
  assert.equal(result.length, 1);
  assert.equal(result[0].value, "provider/model");
});

test("'vibe model openai/gpt-5' still returns provider/model hint (not null)", () => {
  const result = getStickybarArgumentCompletions("vibe model openai/gpt-5");
  assert.ok(result);
  assert.equal(result.length, 1);
  assert.equal(result[0].value, "provider/model");
});

test("'vibe generate ' returns theme hint", () => {
  const result = getStickybarArgumentCompletions("vibe generate ");
  assert.ok(result);
  assert.equal(result.length, 1);
  assert.equal(result[0].value, "theme");
});

test("'vibe generate cyberpunk' still returns theme hint (not null)", () => {
  const result = getStickybarArgumentCompletions("vibe generate cyberpunk");
  assert.ok(result);
  assert.equal(result.length, 1);
  assert.equal(result[0].value, "theme");
});

test("unknown action 'vibe foobar' returns null", () => {
  const result = getStickybarArgumentCompletions("vibe foobar ");
  assert.equal(result, null);
});
