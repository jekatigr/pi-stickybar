import { visibleWidth } from "@earendil-works/pi-tui";
import type {
  BuiltinStatusLineSegmentId,
  CustomStatusItem,
  StickybarConfig,
  StatusLineSegmentId,
  StatusLineSegmentOptions,
  VibeSettings,
} from "./types.ts";

const DEFAULT_TOP: BuiltinStatusLineSegmentId[] = [
  "git", "context_pct", "token_in", "token_out", "cost", "time_spent",
];
const DEFAULT_BOTTOM: BuiltinStatusLineSegmentId[] = ["model", "thinking", "path", "extension_statuses"];

const DEFAULT_VIBE: VibeSettings = {
  theme: null,
  mode: "generate",
  model: "openai-codex/gpt-5.4-mini",
  rainbow: false,
  printing: true,
  fallback: "Working",
  refreshInterval: 30,
  prompt: "Generate a 2-4 word {theme} themed loading message ending in ... for: {task}. Capitalize only the first letter, avoid PascalCase or Title Case. {exclude} Output only the message.",
  maxLength: 65,
  lookback: 30,
};

export const DEFAULT_STICKYBAR_CONFIG: StickybarConfig = {
  showLastPrompt: true,
  top: DEFAULT_TOP,
  bottom: DEFAULT_BOTTOM,
  options: {
    path: { mode: "basename", maxLength: 32 },
    git: { polling: "full", showBranch: true, showStaged: true, showUnstaged: true, showUntracked: true },
    time: { format: "24h", showSeconds: false },
  },
  customItems: [],
  vibe: DEFAULT_VIBE,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function segmentId(value: unknown): StatusLineSegmentId | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if ((Object.values<string>(BUILTIN_SEGMENTS) as string[]).includes(id) || /^custom:[a-zA-Z0-9_-]+$/.test(id)) {
    return id as StatusLineSegmentId;
  }
  return null;
}

const BUILTIN_SEGMENTS: Record<BuiltinStatusLineSegmentId, BuiltinStatusLineSegmentId> = {
  model: "model", path: "path", git: "git", token_in: "token_in", token_out: "token_out",
  token_total: "token_total", cost: "cost", context_pct: "context_pct", context_total: "context_total",
  time_spent: "time_spent", time: "time", session: "session", hostname: "hostname",
  cache_read: "cache_read", cache_write: "cache_write", thinking: "thinking", extension_statuses: "extension_statuses",
};

function parseSegmentList(value: unknown, fallback: readonly StatusLineSegmentId[]): StatusLineSegmentId[] {
  if (!Array.isArray(value)) return [...fallback];
  const seen = new Set<string>();
  const result: StatusLineSegmentId[] = [];
  for (const raw of value) {
    const id = segmentId(raw);
    if (id && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

function parseOptions(value: unknown): StatusLineSegmentOptions {
  if (!isRecord(value)) return {};
  const options: StatusLineSegmentOptions = {};
  if (isRecord(value.path)) {
    options.path = {
      ...(value.path.mode === "basename" || value.path.mode === "abbreviated" || value.path.mode === "full" ? { mode: value.path.mode } : {}),
      ...(typeof value.path.maxLength === "number" && Number.isFinite(value.path.maxLength) && value.path.maxLength > 0
        ? { maxLength: Math.floor(value.path.maxLength) } : {}),
    };
  }
  if (isRecord(value.git)) {
    options.git = {
      ...(typeof value.git.showBranch === "boolean" ? { showBranch: value.git.showBranch } : {}),
      ...(typeof value.git.showStaged === "boolean" ? { showStaged: value.git.showStaged } : {}),
      ...(typeof value.git.showUnstaged === "boolean" ? { showUnstaged: value.git.showUnstaged } : {}),
      ...(typeof value.git.showUntracked === "boolean" ? { showUntracked: value.git.showUntracked } : {}),
      ...(value.git.polling === "full" || value.git.polling === "branch" || value.git.polling === "off" ? { polling: value.git.polling } : {}),
    };
  }
  if (isRecord(value.time)) {
    options.time = {
      ...(value.time.format === "12h" || value.time.format === "24h" ? { format: value.time.format } : {}),
      ...(typeof value.time.showSeconds === "boolean" ? { showSeconds: value.time.showSeconds } : {}),
    };
  }
  return options;
}

export function mergeSegmentOptions(base: StatusLineSegmentOptions, override: StatusLineSegmentOptions): StatusLineSegmentOptions {
  return {
    path: { ...base.path, ...override.path },
    git: { ...base.git, ...override.git },
    time: { ...base.time, ...override.time },
  };
}

function parseCustomItems(value: unknown): CustomStatusItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: CustomStatusItem[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(raw.id) || seen.has(raw.id)) continue;
    seen.add(raw.id);
    result.push({
      id: raw.id,
      statusKey: typeof raw.statusKey === "string" && raw.statusKey.trim() ? raw.statusKey.trim() : raw.id,
      prefix: typeof raw.prefix === "string" && raw.prefix.trim() ? raw.prefix.trim() : undefined,
      hideWhenMissing: raw.hideWhenMissing !== false,
      excludeFromExtensionStatuses: raw.excludeFromExtensionStatuses !== false,
    });
  }
  return result;
}

function parseVibe(value: unknown): VibeSettings {
  if (!isRecord(value)) return { ...DEFAULT_VIBE };
  const theme = typeof value.theme === "string" && value.theme.trim() && value.theme.trim().toLowerCase() !== "off"
    ? value.theme.trim() : null;
  return {
    theme,
    mode: value.mode === "file" ? "file" : "generate",
    model: typeof value.model === "string" && value.model.includes("/") ? value.model : DEFAULT_VIBE.model,
    rainbow: value.rainbow === true,
    printing: value.printing !== false,
    fallback: typeof value.fallback === "string" && value.fallback.trim() ? value.fallback.trim() : DEFAULT_VIBE.fallback,
    refreshInterval: typeof value.refreshInterval === "number" && Number.isFinite(value.refreshInterval)
      ? Math.max(0, Math.floor(value.refreshInterval)) : DEFAULT_VIBE.refreshInterval,
    prompt: typeof value.prompt === "string" && value.prompt.trim() ? value.prompt : DEFAULT_VIBE.prompt,
    maxLength: typeof value.maxLength === "number" && Number.isFinite(value.maxLength)
      ? Math.max(4, Math.floor(value.maxLength)) : DEFAULT_VIBE.maxLength,
    lookback: typeof value.lookback === "number" && Number.isFinite(value.lookback)
      ? Math.max(0, Math.floor(value.lookback)) : DEFAULT_VIBE.lookback,
  };
}

/** Reads only the canonical `stickybar` object. Legacy shapes intentionally fall back to defaults. */
export function parseStickybarConfig(value: unknown): StickybarConfig {
  if (!isRecord(value)) return structuredClone(DEFAULT_STICKYBAR_CONFIG);
  const customItems = parseCustomItems(value.customItems);
  const customIds = new Set(customItems.map((item) => `custom:${item.id}`));
  const known = (id: StatusLineSegmentId) => !id.startsWith("custom:") || customIds.has(id);
  const top = parseSegmentList(value.top, DEFAULT_TOP).filter(known);
  const topIds = new Set(top);
  const bottom = parseSegmentList(value.bottom, DEFAULT_BOTTOM).filter((id) => known(id) && !topIds.has(id));
  return {
    showLastPrompt: value.showLastPrompt !== false,
    top,
    bottom,
    options: mergeSegmentOptions(DEFAULT_STICKYBAR_CONFIG.options, parseOptions(value.options)),
    customItems,
    vibe: parseVibe(value.vibe),
  };
}

export function collectHiddenExtensionStatusKeys(customItems: readonly CustomStatusItem[]): Set<string> {
  return new Set(customItems.filter((item) => item.excludeFromExtensionStatuses).map((item) => item.statusKey));
}

export function normalizeExtensionStatusValue(value: string): string | null {
  const stripped = value.replace(/(\x1b\[[0-9;]*m|\s|·|[|])+$/, "");
  return visibleWidth(stripped) > 0 ? stripped : null;
}

export function normalizeCompactExtensionStatus(value: string): string | null {
  return value.trimStart().startsWith("[") ? null : normalizeExtensionStatusValue(value);
}
