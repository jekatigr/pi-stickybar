import assert from "node:assert/strict";
import test from "node:test";
import { createRenderScheduler } from "../src/render-scheduler.ts";

test("immediate scheduling preempts a pending throttled render", async () => {
  let renders = 0;
  const scheduler = createRenderScheduler(() => { renders++; }, 100);

  scheduler.schedule();
  scheduler.schedule(0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  scheduler.cancel();

  assert.equal(renders, 1);
});
