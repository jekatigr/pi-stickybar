import { CONFIG_DIR_NAME, copyToClipboard, CustomEditor, getAgentDir, type ExtensionAPI, type ReadonlyFooterDataProvider, type Theme } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";


import { readCoreContextUsage } from "./context-usage.ts";
import { renderFixedEditorCluster } from "./fixed-editor/cluster.ts";
import { emergencyTerminalModeReset, TerminalSplitCompositor } from "./fixed-editor/terminal-split.ts";
import { getGitStatus, invalidateGitBranch, invalidateGitStatus, onGitStatusChange } from "./git-status.ts";
import {
  collectHiddenExtensionStatusKeys,
  getNotificationExtensionStatuses,
  mergeSegmentOptions,
  parseStickybarConfig,
} from "./stickybar-config.ts";
import { createRenderScheduler } from "./render-scheduler.ts";
import { getStickybarArgumentCompletions } from "./stickybar-completions.ts";
import { readStickybarSettings, writeStickybarConfig } from "./settings.ts";
import { renderStatusLayout } from "./status-layout.ts";
import type { SegmentContext, StickybarConfig } from "./types.ts";
import {
  generateVibesBatch,
  hasVibeFile,
  initVibeManager,
  onVibeAgentEnd,
  onVibeAgentStart,
  onVibeBeforeAgentStart,
  onVibeToolCall,
  updateVibeSettings,
} from "./working-vibes.ts";

const CUSTOM_COMPACTION_STATUS_KEY = "compact-policy";
const LAYOUT_CACHE_TTL_MS = 250;
const STREAMING_LAYOUT_CACHE_TTL_MS = 1000;
const STATUS_RENDER_DEBOUNCE_MS = 33;
const CONTEXT_RENDER_INTERVAL_MS = 250;
type SessionAssistantUsage = AssistantMessage["usage"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasUsage(value: unknown): value is SessionAssistantUsage {
  return isRecord(value)
    && typeof value.input === "number"
    && typeof value.output === "number"
    && typeof value.cacheRead === "number"
    && typeof value.cacheWrite === "number"
    && isRecord(value.cost)
    && typeof value.cost.total === "number";
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  return isRecord(value) && value.role === "assistant" && hasUsage(value.usage);
}

function usageTokens(usage: SessionAssistantUsage): number {
  const total = "totalTokens" in usage && typeof usage.totalTokens === "number" ? usage.totalTokens : 0;
  return total || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function customCompactionEnabled(cwd: string): boolean {
  if (!existsSync(join(getAgentDir(), "extensions", "pi-custom-compaction"))) return false;
  for (const path of [join(cwd, CONFIG_DIR_NAME, "compaction-policy.json"), join(getAgentDir(), "compaction-policy.json")]) {
    try {
      if (!existsSync(path)) continue;
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      return isRecord(parsed) && parsed.enabled === true;
    } catch {
      return false;
    }
  }
  return false;
}

export default function stickybar(pi: ExtensionAPI) {
  let config = parseStickybarConfig(undefined);
  let currentCtx: any = null;
  let footerData: ReadonlyFooterDataProvider | null = null;
  let tui: any = null;
  let editor: any = null;
  let compositor: TerminalSplitCompositor | null = null;
  let sessionStartedAt: number | null = null;
  let frozenElapsedMs = 0;
  let streaming = false;
  let liveUsage: SessionAssistantUsage | null = null;
  let lastUserPrompt = "";
  let thinkingLevel: string | null = null;
  let activeModel: any = null;
  let customCompaction = false;
  let footerRestore: (() => void) | null = null;
  let removeGitStatusListener: (() => void) | null = null;
  let cachedLayout: { width: number; at: number; value: { top: string; bottom: string } } | null = null;

  const scheduler = createRenderScheduler(() => tui?.requestRender(), STATUS_RENDER_DEBOUNCE_MS);
  const invalidate = (immediate = false) => {
    cachedLayout = null;
    if (immediate) scheduler.schedule(0);
    else scheduler.schedule();
  };

  function installStatusHook(data: ReadonlyFooterDataProvider): void {
    footerRestore?.();
    const mutable = data as ReadonlyFooterDataProvider & { setExtensionStatus?: (key: string, value: string | undefined) => void };
    if (typeof mutable.setExtensionStatus !== "function") return;
    const original = mutable.setExtensionStatus;
    const patched = function(this: unknown, key: string, value: string | undefined) {
      original.call(this, key, value);
      invalidate(true);
    };
    mutable.setExtensionStatus = patched;
    footerRestore = () => {
      if (mutable.setExtensionStatus === patched) mutable.setExtensionStatus = original;
    };
  }

  function segmentContext(theme: Theme): SegmentContext {
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
    let latest: SessionAssistantUsage | undefined;
    let sessionThinking: string | null = null;
    for (const entry of currentCtx?.sessionManager?.getBranch?.() ?? []) {
      if (!isRecord(entry)) continue;
      if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") sessionThinking = entry.thinkingLevel;
      if (entry.type !== "message" || !isAssistantMessage(entry.message)) continue;
      const message = entry.message;
      if (message.stopReason === "error" || message.stopReason === "aborted") continue;
      input += message.usage.input;
      output += message.usage.output;
      cacheRead += message.usage.cacheRead;
      cacheWrite += message.usage.cacheWrite;
      cost += message.usage.cost.total;
      if (usageTokens(message.usage)) latest = message.usage;
    }
    const activeUsage = streaming ? liveUsage ?? latest : latest;
    const coreUsage = streaming && liveUsage ? null : readCoreContextUsage(currentCtx);
    const contextWindow = coreUsage?.contextWindow ?? activeModel?.contextWindow ?? currentCtx?.model?.contextWindow ?? 0;
    const contextPercent = coreUsage
      ? coreUsage.contextPercent
      : (contextWindow ? (activeUsage ? usageTokens(activeUsage) / contextWindow * 100 : 0) : 0);
    const extensionStatuses = footerData?.getExtensionStatuses() ?? new Map<string, string>();
    return {
      model: activeModel ?? currentCtx?.model,
      thinkingLevel: thinkingLevel ?? sessionThinking ?? currentCtx?.getThinkingLevel?.() ?? "off",
      sessionId: currentCtx?.sessionManager?.getSessionId?.(),
      cwd: currentCtx?.cwd,
      usageStats: { input, output, cacheRead, cacheWrite, cost },
      contextPercent,
      contextWindow,
      autoCompactEnabled: currentCtx?.settingsManager?.getCompactionSettings?.()?.enabled ?? true,
      customCompactionEnabled: customCompaction || extensionStatuses.has(CUSTOM_COMPACTION_STATUS_KEY),
      usingSubscription: (activeModel ?? currentCtx?.model)
        ? currentCtx.modelRegistry?.isUsingOAuth?.(activeModel ?? currentCtx.model) ?? false
        : false,
      timerActive: sessionStartedAt !== null || frozenElapsedMs > 0,
      sessionStartTime: streaming
        ? sessionStartedAt ?? Date.now()
        : Date.now() - frozenElapsedMs,
      git: getGitStatus(footerData?.getGitBranch() ?? null, config.options.git?.polling),
      extensionStatuses,
      hiddenExtensionStatusKeys: collectHiddenExtensionStatusKeys(config.customItems),
      customItemsById: new Map(config.customItems.map((item) => [item.id, item])),
      options: mergeSegmentOptions({}, config.options),
      theme,
    };
  }

  function currentLayout(width: number, theme: Theme): { top: string; bottom: string } {
    if (!currentCtx) return { top: "", bottom: "" };
    const now = Date.now();
    const ttl = streaming ? STREAMING_LAYOUT_CACHE_TTL_MS : LAYOUT_CACHE_TTL_MS;
    if (cachedLayout && cachedLayout.width === width && now - cachedLayout.at < ttl) return cachedLayout.value;
    const value = renderStatusLayout(config, segmentContext(theme), width);
    cachedLayout = { width, at: now, value };
    return value;
  }

  function removeLeadingMargin(line: string): string {
    const match = line.match(/^((?:\x1b\[[0-9;]*m)*)\s+/);
    return match ? `${match[1]}${line.slice(match[0].length)}` : line;
  }

  function lastPromptLines(width: number, theme: Theme): string[] {
    if (!config.showLastPrompt || !lastUserPrompt) return [];
    const prefix = theme.fg("dim", "↳ ");
    const available = width - visibleWidth(prefix);
    if (available < 8) return [];
    return [`${prefix}${theme.fg("dim", truncateToWidth(lastUserPrompt.replace(/\s+/g, " ").trim(), available, "…"))}`];
  }

  function notificationLines(width: number): string[] {
    if (!footerData) return [];
    const hidden = collectHiddenExtensionStatusKeys(config.customItems);
    return getNotificationExtensionStatuses(footerData.getExtensionStatuses(), hidden)
      .filter((line) => visibleWidth(line) <= width)
      .map((line) => ` ${line}`);
  }

  function topLines(width: number, theme: Theme): string[] {
    const line = currentLayout(width, theme).top;
    return line ? [line] : [];
  }

  function bottomLines(width: number, theme: Theme): string[] {
    const line = currentLayout(width, theme).bottom;
    return line ? [line] : [];
  }

  function disposeCompositor(resetTerminal = false): void {
    const hadCompositor = compositor !== null;
    compositor?.dispose({ resetExtendedKeyboardModes: resetTerminal });
    if (!hadCompositor && resetTerminal) process.stdout.write(emergencyTerminalModeReset());
    compositor = null;
  }

  function parentOf(child: unknown): { container: any; index: number } | null {
    const children = Array.isArray(tui?.children) ? tui.children : [];
    const index = children.findIndex((candidate: any) => Array.isArray(candidate?.children) && candidate.children.includes(child));
    return index < 0 ? null : { container: children[index], index };
  }

  function installCompositor(ctx: any): void {
    disposeCompositor();
    if (!config.fixedEditor || !ctx.hasUI || !editor || !tui?.terminal) return;
    const match = parentOf(editor);
    if (!match) return;
    const children = tui.children as any[];
    const editorContainer = match.container;
    const statusContainer = children[match.index - 2];
    const above = children[match.index - 1];
    const below = children[match.index + 1];
    const fallbackTheme = ctx.ui.theme;
    let instance: TerminalSplitCompositor;
    instance = new TerminalSplitCompositor({
      tui,
      terminal: tui.terminal,
      mouseScroll: config.mouseScroll,
      onCopySelection: copyToClipboard,
      getShowHardwareCursor: () => tui.getShowHardwareCursor?.() ?? false,
      renderCluster: (width, rows) => {
        const theme = currentCtx?.ui?.theme ?? fallbackTheme;
        const nativeStatusLines = statusContainer?.render ? instance.renderHidden(statusContainer, width) : [];
        // Pi may emit blank/status helper rows before the actual working text.
        // Keep exactly the last visible row as the stable themed-working slot.
        const visibleWorkingLine = nativeStatusLines.filter((line) => visibleWidth(line) > 0).at(-1) ?? "";
        const vibeStatusLine = config.vibe.theme ? [visibleWorkingLine] : nativeStatusLines;
        return renderFixedEditorCluster({
          width,
          terminalRows: rows,
          statusLines: [
            ...(above?.render ? instance.renderHidden(above, width) : []),
            ...notificationLines(width),
            ...vibeStatusLine,
          ].map(removeLeadingMargin),
          topLines: topLines(width, theme),
          editorLines: instance.renderHidden(editorContainer, width),
          secondaryLines: [...bottomLines(width, theme), ...(below?.render ? instance.renderHidden(below, width) : [])],
          lastPromptLines: lastPromptLines(width, theme),
        });
      },
    });
    compositor = instance;
    if (statusContainer?.render) instance.hideRenderable(statusContainer);
    if (above?.render) instance.hideRenderable(above);
    instance.hideRenderable(editorContainer);
    if (below?.render) instance.hideRenderable(below);
    instance.install();
    tui.requestRender(true);
  }

  function installWidgets(ctx: any): void {
    ctx.ui.setWidget("stickybar-top", (_tui: any, theme: Theme) => ({ render: (width: number) => topLines(width, theme), invalidate, dispose() {} }), { placement: "aboveEditor" });
    ctx.ui.setWidget("stickybar-bottom", (_tui: any, theme: Theme) => ({ render: (width: number) => bottomLines(width, theme), invalidate, dispose() {} }), { placement: "belowEditor" });
    ctx.ui.setWidget("stickybar-last-prompt", (_tui: any, theme: Theme) => ({ render: (width: number) => lastPromptLines(width, theme), invalidate, dispose() {} }), { placement: "belowEditor" });
  }

  function setupUi(ctx: any): void {
    disposeCompositor();
    ctx.ui.setWidget("stickybar-top", undefined);
    ctx.ui.setWidget("stickybar-bottom", undefined);
    ctx.ui.setWidget("stickybar-last-prompt", undefined);
    const factory = (editorTui: any, theme: any, keybindings: any) => {
      const next = new CustomEditor(editorTui, theme, keybindings);
      let submit: unknown;
      Object.defineProperty(next, "onSubmit", {
        configurable: true,
        get: () => submit,
        set: (handler: unknown) => {
          submit = typeof handler === "function" ? (text: string) => {
            compositor?.jumpToRootBottom();
            (handler as (value: string) => void)(text);
          } : handler;
        },
      });
      const originalHandleInput = next.handleInput.bind(next);
      next.handleInput = (data: string) => {
        const before = next.getExpandedText();
        originalHandleInput(data);
        const isHistoryKey = keybindings.matches(data, "tui.editor.cursorUp") || keybindings.matches(data, "tui.editor.cursorDown");
        if (!isHistoryKey || next.getExpandedText() === before) return;

        // Pi restores recalled history with its cursor at column zero. Keep normal
        // cursor movement unchanged, but put recalled prompts at their editable end.
        const state = Reflect.get(next, "state");
        const lines = state && typeof state === "object" ? Reflect.get(state, "lines") : null;
        if (!Array.isArray(lines)) return;
        const lastLine = Math.max(0, lines.length - 1);
        Reflect.set(state, "cursorLine", lastLine);
        Reflect.set(state, "cursorCol", typeof lines[lastLine] === "string" ? lines[lastLine].length : 0);
        Reflect.set(next, "lastAction", null);
        Reflect.set(next, "preferredVisualCol", null);
        editorTui.requestRender();
      };
      editor = next;
      return next;
    };
    ctx.ui.setEditorComponent(factory);
    ctx.ui.setFooter((footerTui: any, _theme: Theme, data: ReadonlyFooterDataProvider) => {
      footerData = data;
      tui = footerTui;
      installStatusHook(data);
      const unsubscribe = data.onBranchChange(() => invalidate(true));
      return { render: () => [], invalidate, dispose: () => { unsubscribe(); footerRestore?.(); footerRestore = null; } };
    });
    if (config.fixedEditor) installCompositor(ctx);
    else installWidgets(ctx);
  }

  function persistVibe(ctx: any): void {
    updateVibeSettings(config.vibe);
    if (!writeStickybarConfig(ctx.cwd, config)) ctx.ui.notify("Vibe updated for this session, but settings could not be saved", "warning");
  }

  pi.registerCommand("stickybar", {
    description: "Show Stickybar status or configure working vibes",
    getArgumentCompletions: getStickybarArgumentCompletions,
    handler: async (args, ctx) => {
      const words = args.trim().split(/\s+/).filter(Boolean);
      if (!words.length) {
        ctx.ui.notify(`Stickybar: fixed editor ${config.fixedEditor ? "on" : "off"}; vibe ${config.vibe.theme ?? "off"}`, "info");
        return;
      }
      if (words[0] !== "vibe") {
        ctx.ui.notify("Usage: /stickybar [vibe [theme|off|mode|model|rainbow|generate]]", "info");
        return;
      }
      const action = words[1]?.toLowerCase();
      if (!action) {
        ctx.ui.notify(`Vibe: ${config.vibe.theme ?? "off"}; ${config.vibe.mode}; ${config.vibe.rainbow ? "rainbow" : "plain"}; ${config.vibe.model}`, "info");
        return;
      }
      if (action === "off") config.vibe.theme = null;
      else if (action === "rainbow") config.vibe.rainbow = words[2] === "on" ? true : words[2] === "off" ? false : !config.vibe.rainbow;
      else if (action === "mode") {
        if (words[2] !== "generate" && words[2] !== "file") return ctx.ui.notify("Usage: /stickybar vibe mode generate|file", "warning");
        if (words[2] === "file" && config.vibe.theme && !hasVibeFile(config.vibe.theme)) return ctx.ui.notify("Generate a vibe file before selecting file mode", "warning");
        config.vibe.mode = words[2];
      } else if (action === "model") {
        const model = words.slice(2).join("/");
        if (!model.includes("/")) return ctx.ui.notify("Usage: /stickybar vibe model provider/model", "warning");
        config.vibe.model = model;
      } else if (action === "generate") {
        const count = /^\d+$/.test(words.at(-1) ?? "") ? Number(words.pop()) : 100;
        const theme = words.slice(2).join(" ");
        if (!theme) return ctx.ui.notify("Usage: /stickybar vibe generate <theme> [count]", "warning");
        const result = await generateVibesBatch(theme, count);
        return ctx.ui.notify(result.success ? `Generated ${result.count} vibes for ${theme}` : `Vibe generation failed: ${result.error}`, result.success ? "info" : "error");
      } else {
        config.vibe.theme = words.slice(1).join(" ");
      }
      persistVibe(ctx);
      const fileNote = config.vibe.mode === "file" && config.vibe.theme && !hasVibeFile(config.vibe.theme) ? " (vibe file missing)" : "";
      ctx.ui.notify(`Vibe: ${config.vibe.theme ?? "off"}${fileNote}`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    config = parseStickybarConfig(readStickybarSettings(ctx.cwd).stickybar);
    removeGitStatusListener?.();
    removeGitStatusListener = onGitStatusChange(() => invalidate(true));
    customCompaction = customCompactionEnabled(ctx.cwd);
    streaming = false;
    sessionStartedAt = null;
    frozenElapsedMs = 0;
    liveUsage = null;
    lastUserPrompt = "";
    thinkingLevel = pi.getThinkingLevel();
    activeModel = ctx.model ?? null;
    initVibeManager(ctx, config.vibe);
    if (ctx.hasUI) setupUi(ctx);
    invalidate(true);
  });

  pi.on("session_shutdown", async (event) => {
    scheduler.cancel();
    footerRestore?.();
    footerRestore = null;
    removeGitStatusListener?.();
    removeGitStatusListener = null;
    disposeCompositor(event.reason === "quit" || event.reason === "reload");
    currentCtx = null;
    footerData = null;
    tui = null;
    editor = null;
    activeModel = null;
    sessionStartedAt = null;
    frozenElapsedMs = 0;
    lastUserPrompt = "";
    cachedLayout = null;
  });

  pi.on("model_select", async (event, ctx) => {
    currentCtx = ctx;
    activeModel = event.model ?? ctx.model ?? null;
    invalidate(true);
  });
  pi.on("thinking_level_select", async (event, ctx) => { currentCtx = ctx; thinkingLevel = event.level; invalidate(true); });
  pi.on("session_tree", async (_event, ctx) => { currentCtx = ctx; thinkingLevel = null; liveUsage = null; invalidate(true); });
  pi.on("session_compact", async (_event, ctx) => {
    currentCtx = ctx;
    // The previous assistant usage describes the pre-compaction context. Pi
    // reports usage as unknown until the next response, so do not reuse it.
    liveUsage = null;
    invalidate(true);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    currentCtx = ctx;
    lastUserPrompt = event.prompt;
    if (ctx.hasUI) onVibeBeforeAgentStart(event.prompt, ctx.ui.setWorkingMessage);
  });
  pi.on("agent_start", async (_event, ctx) => {
    currentCtx = ctx;
    streaming = true;
    liveUsage = null;
    frozenElapsedMs = 0;
    sessionStartedAt = Date.now();
    if (ctx.hasUI) onVibeAgentStart(ctx.ui.setWorkingMessage);
    invalidate(true);
  });
  pi.on("message_update", async (event, ctx) => {
    if (
      isAssistantMessage(event.message)
      && event.message.stopReason !== "error"
      && event.message.stopReason !== "aborted"
      && usageTokens(event.message.usage) > 0
    ) {
      currentCtx = ctx;
      liveUsage = event.message.usage;
      cachedLayout = null;
      scheduler.schedule(CONTEXT_RENDER_INTERVAL_MS);
    }
  });
  pi.on("message_end", async (event, ctx) => {
    currentCtx = ctx;
    if (
      isAssistantMessage(event.message)
      && event.message.stopReason !== "error"
      && event.message.stopReason !== "aborted"
      && usageTokens(event.message.usage) > 0
    ) liveUsage = event.message.usage;
    invalidate(true);
  });
  pi.on("agent_end", async (_event, ctx) => {
    currentCtx = ctx;
    if (sessionStartedAt !== null) frozenElapsedMs = Date.now() - sessionStartedAt;
    streaming = false;
    if (ctx.hasUI) onVibeAgentEnd(ctx.ui.setWorkingMessage);
    invalidate(true);
  });
  pi.on("tool_call", async (event, ctx) => {
    if (ctx.hasUI) onVibeToolCall(`using ${event.toolName}`, ctx.ui.setWorkingMessage);
  });
  pi.on("tool_result", async (event) => {
    if (event.toolName === "write" || event.toolName === "edit") invalidateGitStatus();
    if (event.toolName === "bash" && /\bgit\s+(checkout|switch|merge|rebase|pull|reset|stash)/.test(String(event.input?.command ?? ""))) {
      invalidateGitStatus();
      invalidateGitBranch();
      setTimeout(() => invalidate(true), 100);
    }
  });
}
