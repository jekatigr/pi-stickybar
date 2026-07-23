import { hostname } from "node:os";
import { basename } from "node:path";
import type { BuiltinStatusLineSegmentId, RenderedSegment, SegmentContext, SemanticColor, StatusLineSegment, StatusLineSegmentId } from "./types.ts";
import { color, separator } from "./colors.ts";
import { normalizeCompactExtensionStatus, normalizeExtensionStatusValue } from "./stickybar-config.ts";

const SEP = separator(" | ");

function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m${seconds % 60}s` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function simple(id: BuiltinStatusLineSegmentId, render: (ctx: SegmentContext) => RenderedSegment): StatusLineSegment {
  return { id, render };
}

const segments: StatusLineSegment[] = [
  simple("model", (ctx) => ({ content: color(ctx.theme, "model", ctx.model?.name || ctx.model?.id || "no-model"), visible: true })),
  simple("path", (ctx) => {
    const { mode = "basename", maxLength = 32 } = ctx.options.path ?? {};
    let value = ctx.cwd ?? process.cwd();
    if (mode === "basename") value = basename(value) || value;
    else {
      const home = process.env.HOME || process.env.USERPROFILE;
      if (home && value.startsWith(home)) value = `~${value.slice(home.length)}`;
      if (mode === "abbreviated" && value.length > maxLength) value = `…${value.slice(1 - maxLength)}`;
    }
    return { content: color(ctx.theme, "path", `⌂ ${value}`), visible: true };
  }),
  simple("git", (ctx) => {
    const { branch, staged, unstaged, untracked } = ctx.git;
    const options = ctx.options.git ?? {};
    if (!branch && !staged && !unstaged && !untracked) return { content: "", visible: false };
    const dirty = staged > 0 || unstaged > 0 || untracked > 0;
    const parts: string[] = [];
    if (branch && options.showBranch !== false) parts.push(color(ctx.theme, dirty ? "gitDirty" : "gitClean", `⎇ ${branch}`));
    if (unstaged && options.showUnstaged !== false) parts.push(ctx.theme.fg("warning", `*${unstaged}`));
    if (staged && options.showStaged !== false) parts.push(ctx.theme.fg("success", `+${staged}`));
    if (untracked && options.showUntracked !== false) parts.push(ctx.theme.fg("muted", `?${untracked}`));
    return { content: parts.join(" "), visible: parts.length > 0 };
  }),
  simple("thinking", (ctx) => {
    const level = ctx.thinkingLevel || "off";
    const label = `think:${({ minimal: "min", medium: "med" } as Record<string, string>)[level] ?? level}`;
    return { content: color(ctx.theme, "thinking", label), visible: true };
  }),
  simple("token_in", (ctx) => ctx.usageStats.input ? { content: color(ctx.theme, "tokens", `in:${formatTokens(ctx.usageStats.input)}`), visible: true } : { content: "", visible: false }),
  simple("token_out", (ctx) => ctx.usageStats.output ? { content: color(ctx.theme, "tokens", `out:${formatTokens(ctx.usageStats.output)}`), visible: true } : { content: "", visible: false }),
  simple("token_total", (ctx) => {
    const total = ctx.usageStats.input + ctx.usageStats.output + ctx.usageStats.cacheRead + ctx.usageStats.cacheWrite;
    return total ? { content: color(ctx.theme, "tokens", `tok:${formatTokens(total)}`), visible: true } : { content: "", visible: false };
  }),
  simple("cost", (ctx) => ctx.usingSubscription || ctx.usageStats.cost ? { content: color(ctx.theme, "cost", ctx.usingSubscription ? "sub" : `$${ctx.usageStats.cost.toFixed(2)}`), visible: true } : { content: "", visible: false }),
  simple("context_pct", (ctx) => {
    if (ctx.customCompactionEnabled || !ctx.contextWindow) return { content: "", visible: false };
    const shade: SemanticColor = ctx.contextPercent !== null && ctx.contextPercent > 90
      ? "contextError"
      : ctx.contextPercent !== null && ctx.contextPercent > 70 ? "contextWarn" : "context";
    const autoCompact = ctx.autoCompactEnabled ? " AC" : "";
    const percent = ctx.contextPercent === null ? "?" : `${ctx.contextPercent.toFixed(1)}%`;
    return { content: color(ctx.theme, shade, `◫ ${percent}/${formatTokens(ctx.contextWindow)}${autoCompact}`), visible: true };
  }),
  simple("context_total", (ctx) => ctx.customCompactionEnabled || !ctx.contextWindow ? { content: "", visible: false } : { content: color(ctx.theme, "context", `◫ ${formatTokens(ctx.contextWindow)}`), visible: true }),
  simple("time_spent", (ctx) => {
    if (!ctx.timerActive) return { content: "", visible: false };
    const elapsed = Date.now() - ctx.sessionStartTime;
    return { content: `◷ ${formatDuration(elapsed)}`, visible: true };
  }),
  simple("time", (ctx) => {
    const now = new Date();
    const { format = "24h", showSeconds = false } = ctx.options.time ?? {};
    let hours = now.getHours();
    const suffix = format === "12h" ? (hours >= 12 ? "pm" : "am") : "";
    if (format === "12h") hours = hours % 12 || 12;
    return { content: `◷ ${hours}:${String(now.getMinutes()).padStart(2, "0")}${showSeconds ? `:${String(now.getSeconds()).padStart(2, "0")}` : ""}${suffix}`, visible: true };
  }),
  simple("session", (ctx) => ({ content: `session:${ctx.sessionId?.slice(0, 8) || "new"}`, visible: true })),
  simple("hostname", () => ({ content: hostname().split(".")[0] || "host", visible: true })),
  simple("cache_read", (ctx) => ctx.usageStats.cacheRead ? { content: color(ctx.theme, "tokens", `cache-in:${formatTokens(ctx.usageStats.cacheRead)}`), visible: true } : { content: "", visible: false }),
  simple("cache_write", (ctx) => ctx.usageStats.cacheWrite ? { content: color(ctx.theme, "tokens", `cache-out:${formatTokens(ctx.usageStats.cacheWrite)}`), visible: true } : { content: "", visible: false }),
  simple("extension_statuses", (ctx) => {
    const values = [...ctx.extensionStatuses].flatMap(([key, value]) => ctx.hiddenExtensionStatusKeys.has(key) ? [] : [normalizeCompactExtensionStatus(value)]).filter((value): value is string => Boolean(value));
    return { content: values.join(SEP), visible: values.length > 0 };
  }),
];

export const SEGMENTS = Object.fromEntries(segments.map((segment) => [segment.id, segment])) as Record<BuiltinStatusLineSegmentId, StatusLineSegment>;

export function renderSegment(id: StatusLineSegmentId, ctx: SegmentContext): RenderedSegment {
  if (id.startsWith("custom:")) {
    const custom = ctx.customItemsById.get(id.slice("custom:".length));
    const value = custom ? normalizeExtensionStatusValue(ctx.extensionStatuses.get(custom.statusKey) ?? "") : null;
    if (!custom || (!value && custom.hideWhenMissing)) return { content: "", visible: false };
    const content = value ? (custom.prefix ? `${custom.prefix}${SEP}${value}` : value) : (custom.prefix ?? custom.id);
    return { content, visible: true };
  }
  return SEGMENTS[id as BuiltinStatusLineSegmentId]?.render(ctx) ?? { content: "", visible: false };
}
