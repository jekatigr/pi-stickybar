import { complete, type Context } from "@earendil-works/pi-ai/compat";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rainbow } from "./colors.ts";
import type { VibeSettings } from "./types.ts";

let context: ExtensionContext | null = null;
let config: VibeSettings | null = null;
let streaming = false;
let generation: AbortController | null = null;
let lastRefresh = 0;
let currentText = "";
let visibleText = "";
let animation: ReturnType<typeof setInterval> | null = null;
let printingAnimation: ReturnType<typeof setInterval> | null = null;

const PRINTING_INTERVAL_MS = 15;
let recent: string[] = [];
let fileVibes: string[] = [];
let fileTheme: string | null = null;
let fileIndex = 0;
let lastTask = "";
let preparedNext: string | null = null;
let preparing: Promise<void> | null = null;
let settingsVersion = 0;

function vibeDir(): string {
  return join(getAgentDir(), "vibes");
}

function slug(theme: string): string {
  return theme.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "theme";
}

function vibePath(theme: string): string {
  return join(vibeDir(), `${slug(theme)}.txt`);
}

function historyPath(theme: string): string {
  return join(vibeDir(), `${slug(theme)}.history.json`);
}

/** Best-effort, non-blocking: never awaited by callers so disk I/O can't stall the UI. */
async function loadHistory(theme: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(historyPath(theme), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

async function saveHistory(theme: string, values: string[]): Promise<void> {
  try {
    await mkdir(vibeDir(), { recursive: true });
    await writeFile(historyPath(theme), JSON.stringify(values));
  } catch {
    // best-effort persistence; a failed write just means dedup resets next session
  }
}

/** Loads persisted history for `theme` into `recent`, guarding against a theme switch mid-flight. */
async function loadRecentHistory(theme: string | null, lookback: number, version = settingsVersion): Promise<void> {
  if (!theme || lookback <= 0) {
    if (version === settingsVersion) recent = [];
    return;
  }
  const history = await loadHistory(theme);
  if (version === settingsVersion && config?.theme === theme) recent = history.slice(0, lookback);
}

function message(text: string): string {
  const maxLength = config?.maxLength ?? 65;
  const normalized = text.trim().replace(/^['"]|['"]$/g, "");
  const withEllipsis = normalized.endsWith("...") ? normalized : `${normalized.replace(/\.+$/, "")}...`;
  return withEllipsis.length <= maxLength ? withEllipsis : `${withEllipsis.slice(0, maxLength - 3)}...`;
}

function fallback(): string {
  return message(config?.fallback ?? "Working");
}

function render(setWorkingMessage: (text?: string) => void, text: string): void {
  setWorkingMessage(config?.rainbow ? rainbow(text) : text);
}

function stopPrinting(): void {
  if (printingAnimation) clearInterval(printingAnimation);
  printingAnimation = null;
}

function emit(setWorkingMessage: (text?: string) => void, text: string): void {
  stopPrinting();
  currentText = text;
  visibleText = text;
  render(setWorkingMessage, text);
}

/** Reveals refreshed vibes one Unicode character at a time. */
function print(setWorkingMessage: (text?: string) => void, text: string): void {
  stopPrinting();
  currentText = text;
  if (!config?.printing || !text) return emit(setWorkingMessage, text);

  const characters = Array.from(text);
  let length = 0;
  visibleText = "";
  render(setWorkingMessage, visibleText);
  printingAnimation = setInterval(() => {
    length++;
    visibleText = characters.slice(0, length).join("");
    render(setWorkingMessage, visibleText);
    if (length >= characters.length) stopPrinting();
  }, PRINTING_INTERVAL_MS);
}

function startAnimation(setWorkingMessage: (text?: string) => void): void {
  if (animation) clearInterval(animation);
  if (!config?.rainbow) return;
  animation = setInterval(() => {
    if (streaming && currentText) render(setWorkingMessage, visibleText);
  }, 100);
}

function stopAnimation(): void {
  if (animation) clearInterval(animation);
  animation = null;
  stopPrinting();
}

function loadFile(theme: string): string[] {
  if (fileTheme === theme) return fileVibes;
  fileTheme = theme;
  fileIndex = 0;
  try {
    fileVibes = existsSync(vibePath(theme))
      ? readFileSync(vibePath(theme), "utf8").split(/\r?\n/).map((line) => message(line)).filter((line) => line !== "...")
      : [];
  } catch {
    fileVibes = [];
  }
  return fileVibes;
}

function nextFileVibe(): string {
  if (!config?.theme) return fallback();
  const vibes = loadFile(config.theme);
  if (!vibes.length) return fallback();
  const value = vibes[fileIndex % vibes.length] ?? fallback();
  fileIndex++;
  return value;
}

function prompt(task: string, settings: VibeSettings): string {
  const exclude = settings.lookback > 0 && recent.length ? `Avoid: ${recent.join(", ")}` : "";
  return settings.prompt
    .replaceAll("{theme}", settings.theme ?? "")
    .replaceAll("{task}", task.slice(0, 150))
    .replaceAll("{exclude}", exclude);
}

async function generate(task: string): Promise<string> {
  const settings = config;
  const version = settingsVersion;
  if (!context || !settings?.theme) return fallback();
  const [provider, ...modelParts] = settings.model.split("/");
  const modelId = modelParts.join("/");
  const model = provider && modelId ? context.modelRegistry.find(provider, modelId) : undefined;
  if (!model) return fallback();
  const controller = new AbortController();
  generation?.abort();
  generation = controller;
  const auth = await context.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || controller.signal.aborted || version !== settingsVersion) return fallback();
  const aiContext: Context = {
    systemPrompt: "Reply with one short loading message and nothing else. Capitalize only the first letter; avoid PascalCase or Title Case.",
    messages: [{ role: "user", content: [{ type: "text", text: prompt(task, settings) }], timestamp: Date.now() }],
  };
  try {
    const response = await complete(model, aiContext, { apiKey: auth.apiKey, headers: auth.headers, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]) });
    const text = response.content.find((part) => part.type === "text")?.text;
    if (!text && response.stopReason === "error" && response.errorMessage) {
      console.debug(`[stickybar] Vibe generation failed for ${settings.model}: ${response.errorMessage}`);
    }
    if (!text || controller.signal.aborted || version !== settingsVersion) return fallback();
    const value = message(text.split("\n")[0] ?? "");
    recent = [value, ...recent.filter((item) => item !== value)].slice(0, settings.lookback);
    if (settings.lookback > 0) void saveHistory(settings.theme, recent);
    return value;
  } catch {
    return fallback();
  }
}

export function initVibeManager(extensionContext: ExtensionContext, settings: VibeSettings): void {
  context = extensionContext;
  config = { ...settings };
  settingsVersion++;
  streaming = false;
  currentText = "";
  visibleText = "";
  recent = [];
  preparedNext = null;
  preparing = null;
  generation?.abort();
  generation = null;
  stopAnimation();
  const version = settingsVersion;
  void loadRecentHistory(settings.theme, settings.lookback).then(() => prepareNext(version));
}

export function updateVibeSettings(settings: VibeSettings): void {
  const themeChanged = config?.theme !== settings.theme;
  settingsVersion++;
  generation?.abort();
  generation = null;
  preparing = null;
  config = { ...settings };
  if (!settings.rainbow && animation) {
    clearInterval(animation);
    animation = null;
  }
  stopPrinting();
  preparedNext = null;
  if (themeChanged) {
    recent = [];
    void loadRecentHistory(settings.theme, settings.lookback, settingsVersion);
  } else {
    recent = recent.slice(0, Math.max(0, settings.lookback));
  }
}

async function prepareNext(version = settingsVersion): Promise<void> {
  const theme = config?.theme;
  if (version !== settingsVersion || !theme || config?.mode === "file") return;
  if (preparing) return preparing;
  const task = lastTask || "a new task";
  const run = (async () => {
    const value = await generate(task);
    if (version === settingsVersion && config?.theme === theme && config.mode !== "file") preparedNext = value;
  })();
  preparing = run;
  void run.finally(() => {
    if (preparing === run) preparing = null;
  });
  return run;
}

export function onVibeBeforeAgentStart(task: string, setWorkingMessage: (text?: string) => void): void {
  if (!config?.theme) return;
  lastTask = task;
  lastRefresh = Date.now();
  if (config.mode !== "file" && preparedNext) {
    print(setWorkingMessage, preparedNext);
    preparedNext = null;
    void prepareNext();
  } else {
    emit(setWorkingMessage, `Working ${config.theme}`);
    void refresh(task, setWorkingMessage);
  }
}

export function onVibeAgentStart(setWorkingMessage: (text?: string) => void): void {
  streaming = true;
  startAnimation(setWorkingMessage);
}

export function onVibeToolCall(task: string, setWorkingMessage: (text?: string) => void): void {
  if (!streaming || !config?.theme || Date.now() - lastRefresh < config.refreshInterval * 1000) return;
  lastRefresh = Date.now();
  void refresh(task, setWorkingMessage);
}

async function refresh(task: string, setWorkingMessage: (text?: string) => void): Promise<void> {
  const version = settingsVersion;
  const value = config?.mode === "file" ? nextFileVibe() : await generate(task);
  if (version !== settingsVersion) return;
  if (streaming || currentText) print(setWorkingMessage, value);
}

export function onVibeAgentEnd(setWorkingMessage: (text?: string) => void): void {
  streaming = false;
  generation?.abort();
  stopAnimation();
  currentText = "";
  visibleText = "";
  setWorkingMessage();
  void prepareNext();
}

export function hasVibeFile(theme: string): boolean { return existsSync(vibePath(theme)); }

export async function generateVibesBatch(theme: string, count = 100): Promise<{ success: boolean; count: number; filePath: string; error?: string }> {
  const filePath = vibePath(theme);
  if (!context || !config) return { success: false, count: 0, filePath, error: "Extension not initialized" };
  const safeCount = Math.max(1, Math.min(500, Math.floor(count)));
  const [provider, ...modelParts] = config.model.split("/");
  const model = provider && modelParts.length ? context.modelRegistry.find(provider, modelParts.join("/")) : undefined;
  if (!model) return { success: false, count: 0, filePath, error: "Configured vibe model was not found" };
  const auth = await context.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return { success: false, count: 0, filePath, error: auth.error };
  const aiContext: Context = {
    systemPrompt: "Reply with one short loading message per line and nothing else.",
    messages: [{ role: "user", content: [{ type: "text", text: `Generate ${safeCount} unique ${theme} themed loading messages, 2-4 words each.` }], timestamp: Date.now() }],
  };
  try {
    const response = await complete(model, aiContext, { apiKey: auth.apiKey, headers: auth.headers, signal: AbortSignal.timeout(1_200_000) });
    const text = response.content.find((part) => part.type === "text")?.text;
    if (!text) {
      return {
        success: false,
        count: 0,
        filePath,
        error: response.stopReason === "error" && response.errorMessage ? response.errorMessage : "No vibes generated",
      };
    }
    const values = text.split(/\r?\n/).map(message).filter((value) => value !== "...");
    if (!values.length) return { success: false, count: 0, filePath, error: "No vibes generated" };
    mkdirSync(vibeDir(), { recursive: true });
    writeFileSync(filePath, values.join("\n") + "\n");
    if (fileTheme === theme) fileTheme = null;
    return { success: true, count: values.length, filePath };
  } catch (error) {
    return { success: false, count: 0, filePath, error: error instanceof Error ? error.message : "Generation failed" };
  }
}
