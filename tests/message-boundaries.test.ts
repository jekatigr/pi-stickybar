import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { collectMessageBoundaries } from "../src/fixed-editor/message-boundaries.ts";

// Builds an object that passes `instanceof <ComponentClass>` (so the boundary
// detection matches Pi's real message components) without invoking the real
// constructor, since we only need render() for these tests.
function fakeComponent(prototype: object, lines: string[]) {
  const component: { render: (width: number) => string[] } = Object.create(prototype);
  component.render = () => lines;
  return component;
}

test("collectMessageBoundaries offsets by preceding containers and records only user prompt starts", () => {
  const preceding = [
    { render: () => ["banner line 1", "banner line 2"] }, // e.g. header container: 2 lines
    { render: () => [] }, // e.g. loaded-resources container: 0 lines
  ];
  const chatContainer = {
    children: [
      fakeComponent(UserMessageComponent.prototype, ["> hello", "> world"]), // 2 lines, starts at 2
      { render: () => ["---"] }, // spacer/border between messages, 1 line
      fakeComponent(AssistantMessageComponent.prototype, ["ok", "done", "!"]), // assistant reply, not a boundary
    ],
  };

  assert.deepEqual(collectMessageBoundaries(preceding, chatContainer, 80), [2]);
});

test("collectMessageBoundaries degrades to an empty list for missing/invalid containers", () => {
  assert.deepEqual(collectMessageBoundaries([], null, 80), []);
  assert.deepEqual(collectMessageBoundaries([], { children: "not-an-array" }, 80), []);
  assert.deepEqual(collectMessageBoundaries([], {}, 80), []);
});

test("collectMessageBoundaries tolerates a throwing render without breaking navigation", () => {
  const chatContainer = {
    children: [
      fakeComponent(UserMessageComponent.prototype, ["a"]),
      {
        render: () => {
          throw new Error("boom");
        },
      },
      fakeComponent(AssistantMessageComponent.prototype, ["b"]),
    ],
  };

  // The throwing sibling contributes 0 lines instead of crashing the lookup; only the
  // leading UserMessageComponent produces a boundary (the AssistantMessageComponent doesn't).
  assert.deepEqual(collectMessageBoundaries([], chatContainer, 80), [0]);
});

test("collectMessageBoundaries collapses a run of consecutive assistant components (one tool-calling turn) into nothing and only reports user prompt starts", () => {
  const chatContainer = {
    children: [
      fakeComponent(UserMessageComponent.prototype, ["> do the thing"]), // 1 line, boundary at 0
      fakeComponent(AssistantMessageComponent.prototype, ["a1"]), // reply, not a boundary
      { render: () => ["[tool call]", "[tool result]"] }, // ToolExecutionComponent-like, 2 lines
      fakeComponent(AssistantMessageComponent.prototype, ["a2"]), // same kind as previous, still not a boundary
      { render: () => ["[tool call 2]"] }, // 1 line
      fakeComponent(AssistantMessageComponent.prototype, ["a3", "final"]), // same kind again, still not a boundary
      fakeComponent(UserMessageComponent.prototype, ["> follow up"]), // kind changes back to user -> new boundary
      fakeComponent(AssistantMessageComponent.prototype, ["a4"]), // reply, not a boundary
    ],
  };

  // Only the 2 user prompt starts, not the assistant replies or any intermediate tool round.
  assert.deepEqual(collectMessageBoundaries([], chatContainer, 80), [0, 8]);
});
