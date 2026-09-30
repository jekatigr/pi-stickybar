import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { droppedPathTextFromInput, replaceDroppedPathInput } from "../src/editor-drops.ts";

const firstPath = process.platform === "win32" ? "C:\\Temp\\Screen Shot.png" : "/tmp/Screen Shot.png";
const secondPath = process.platform === "win32" ? "C:\\Temp\\two words.txt" : "/tmp/two words.txt";

test("converts a bracketed file-URI drop into native path text", () => {
  const input = `\x1b[200~${pathToFileURL(firstPath).href}\x1b[201~`;
  const paths = droppedPathTextFromInput(input);
  assert.equal(paths, firstPath);
  assert.equal(replaceDroppedPathInput(input, paths!), `\x1b[200~${firstPath}\x1b[201~`);
});

test("converts an all-URI drop list and leaves ordinary paste untouched", () => {
  assert.equal(
    droppedPathTextFromInput(`${pathToFileURL(firstPath).href}\n${pathToFileURL(secondPath).href}`),
    `${firstPath} ${secondPath}`,
  );
  assert.equal(droppedPathTextFromInput(`read ${pathToFileURL(firstPath).href}`), null);
  assert.equal(droppedPathTextFromInput("ordinary pasted text"), null);
});
