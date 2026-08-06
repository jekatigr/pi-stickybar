import { AssistantMessageComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";

interface Renderable {
  render(width: number): string[];
}

export interface MessageContainerLocation {
  precedingContainers: unknown[];
  chatContainer: unknown;
}

function isRenderable(value: unknown): value is Renderable {
  return Boolean(value) && typeof (value as { render?: unknown }).render === "function";
}

function renderableLineCount(component: unknown, width: number): number {
  if (!isRenderable(component)) return 0;
  try {
    return component.render(width).length;
  } catch {
    // A malformed/incompatible component should not break navigation.
    return 0;
  }
}

/**
 * Finds Pi's message container and the renderable siblings that precede it.
 *
 * Pi 0.80 mounted header/resources/chat as separate root children, while newer
 * releases mount them below a single document container. Discover the path from
 * the component tree instead of relying on root-child indexes.
 */
export function locateMessageContainer(rootChildren: readonly unknown[]): MessageContainerLocation | null {
  function visit(container: unknown, preceding: unknown[]): MessageContainerLocation | null {
    const children = (container as { children?: unknown[] } | null)?.children;
    if (!Array.isArray(children)) return null;

    if (children.some((child) => child instanceof UserMessageComponent || child instanceof AssistantMessageComponent)) {
      return { precedingContainers: preceding, chatContainer: container };
    }

    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      if (!Array.isArray((child as { children?: unknown[] } | null)?.children)) continue;
      const found = visit(child, [...preceding, ...children.slice(0, index)]);
      if (found) return found;
    }
    return null;
  }

  for (let index = 0; index < rootChildren.length; index++) {
    const found = visit(rootChildren[index], rootChildren.slice(0, index));
    if (found) return found;
  }
  return null;
}

/**
 * Computes the absolute line offset - within Pi's full scrollable transcript
 * render - of every user prompt inside `chatContainer`, so the fixed-editor
 * compositor can jump the viewport straight to a user message (see
 * `TerminalSplitCompositor.jumpToPreviousRootTarget`/`jumpToNextRootTarget`).
 *
 * Only transitions *into* a `UserMessageComponent` are recorded (assistant
 * components are tracked internally to detect the transition, but never
 * produce a boundary themselves). A single agent turn commonly renders
 * several `AssistantMessageComponent` instances in a row - one per
 * tool-calling round, interleaved with `ToolExecutionComponent`s - so this
 * also collapses any such run into nothing, meaning consecutive user
 * components (if that ever happens) would likewise collapse to one boundary.
 *
 * This is computed on demand (only when the user presses a jump shortcut)
 * rather than tracked continuously on every render/scroll tick, so it never
 * adds cost to the normal render path. It re-renders the (typically empty or
 * tiny) containers that come before the chat transcript plus each message
 * inside it, exactly as Pi's own render pass would, purely to recover
 * per-message line offsets. Component render() is expected to be an
 * idempotent function of current state/width, matching how the rest of this
 * file already re-invokes render() outside Pi's own render pass (see
 * `renderHidden`).
 */
export function collectMessageBoundaries(
  precedingContainers: readonly unknown[],
  chatContainer: unknown,
  width: number,
): number[] {
  const container = chatContainer as { children?: unknown[] } | null;
  if (!container || !Array.isArray(container.children)) return [];

  let cursor = 0;
  for (const sibling of precedingContainers) cursor += renderableLineCount(sibling, width);

  const boundaries: number[] = [];
  let previousKind: "user" | "assistant" | null = null;
  for (const child of container.children) {
    const kind = child instanceof UserMessageComponent ? "user" : child instanceof AssistantMessageComponent ? "assistant" : null;
    if (kind && kind !== previousKind) {
      if (kind === "user") boundaries.push(cursor);
      previousKind = kind;
    }
    cursor += renderableLineCount(child, width);
  }
  return boundaries;
}
