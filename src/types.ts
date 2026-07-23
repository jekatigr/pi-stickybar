import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

export type ThemeLike = Pick<Theme, "fg">;

export type SemanticColor =
  | "model"
  | "path"
  | "gitDirty"
  | "gitClean"
  | "thinking"
  | "context"
  | "contextWarn"
  | "contextError"
  | "cost"
  | "tokens";

export type BuiltinStatusLineSegmentId =
  | "model"
  | "path"
  | "git"
  | "token_in"
  | "token_out"
  | "token_total"
  | "cost"
  | "context_pct"
  | "context_total"
  | "time_spent"
  | "time"
  | "session"
  | "hostname"
  | "cache_read"
  | "cache_write"
  | "thinking"
  | "extension_statuses";

export type StatusLineSegmentId = BuiltinStatusLineSegmentId | `custom:${string}`;

export interface StatusLineSegmentOptions {
  path?: {
    mode?: "basename" | "abbreviated" | "full";
    maxLength?: number;
  };
  git?: {
    showBranch?: boolean;
    showStaged?: boolean;
    showUnstaged?: boolean;
    showUntracked?: boolean;
    polling?: "full" | "branch" | "off";
  };
  time?: { format?: "12h" | "24h"; showSeconds?: boolean };
}

export interface VibeSettings {
  theme: string | null;
  mode: "generate" | "file";
  model: string;
  rainbow: boolean;
  fallback: string;
  refreshInterval: number;
  prompt: string;
  maxLength: number;
  lookback: number;
}

export interface CustomStatusItem {
  id: string;
  statusKey: string;
  prefix?: string;
  hideWhenMissing: boolean;
  excludeFromExtensionStatuses: boolean;
}

export interface StickybarConfig {
  fixedEditor: boolean;
  mouseScroll: boolean;
  showLastPrompt: boolean;
  top: StatusLineSegmentId[];
  bottom: StatusLineSegmentId[];
  options: StatusLineSegmentOptions;
  customItems: CustomStatusItem[];
  vibe: VibeSettings;
}

export interface GitStatus {
  branch: string | null;
  staged: number;
  unstaged: number;
  untracked: number;
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface SegmentContext {
  model: { id: string; name?: string; reasoning?: boolean; contextWindow?: number } | undefined;
  thinkingLevel: string;
  sessionId: string | undefined;
  cwd?: string;
  usageStats: UsageStats;
  contextPercent: number;
  contextWindow: number;
  autoCompactEnabled: boolean;
  customCompactionEnabled: boolean;
  usingSubscription: boolean;
  timerActive: boolean;
  sessionStartTime: number;
  git: GitStatus;
  extensionStatuses: ReadonlyMap<string, string>;
  hiddenExtensionStatusKeys: ReadonlySet<string>;
  customItemsById: ReadonlyMap<string, CustomStatusItem>;
  options: StatusLineSegmentOptions;
  theme: ThemeLike;
}

export interface RenderedSegment {
  content: string;
  visible: boolean;
}

export interface StatusLineSegment {
  id: BuiltinStatusLineSegmentId;
  render(ctx: SegmentContext): RenderedSegment;
}

export type PiThemeColor = ThemeColor;
