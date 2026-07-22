import { complete, type Context } from "@earendil-works/pi-ai/compat";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rainbow } from "./colors.ts";
import type { VibeSettings } from "./types.ts";

let context: ExtensionContext | null = null;
let config: VibeSettings | null = null;
let streaming = false;
let generation: AbortController | null = null;
let lastRefresh = 0;
let currentText = "";
let animation: ReturnType<typeof setInterval> | null = null;
let recent: string[] = [];
let fileVibes: string[] = [];
let fileTheme: string | null = null;
let fileIndex = 0;
let lastTask = "";
let preparedNext: string | null = null;
let preparing: Promise<void> | null = null;

function vibeDir(): string {
  return join(getAgentDir(), "vibes");
}

function vibePath(theme: string): string {
  const slug = theme.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "theme";
  return join(vibeDir(), `${slug}.txt`);
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

function emit(setWorkingMessage: (text?: string) => void, text: string): void {
  currentText = text;
  setWorkingMessage(config?.rainbow ? rainbow(text) : text);
}

function startAnimation(setWorkingMessage: (text?: string) => void): void {
  stopAnimation();
  if (!config?.rainbow) return;
  animation = setInterval(() => {
    if (streaming && currentText) setWorkingMessage(rainbow(currentText));
  }, 100);
}

function stopAnimation(): void {
  if (animation) clearInterval(animation);
  animation = null;
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

function prompt(task: string): string {
  const theme = config?.theme ?? "";
  const exclude = recent.length ? `Avoid: ${recent.join(", ")}` : "";
  return (config?.prompt ?? "Generate a {theme} loading message for: {task}")
    .replaceAll("{theme}", theme)
    .replaceAll("{task}", task.slice(0, 150))
    .replaceAll("{exclude}", exclude);
}

async function generate(task: string): Promise<string> {
  if (!context || !config?.theme) return fallback();
  const [provider, ...modelParts] = config.model.split("/");
  const modelId = modelParts.join("/");
  const model = provider && modelId ? context.modelRegistry.find(provider, modelId) : undefined;
  if (!model) return fallback();
  const auth = await context.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return fallback();
  const aiContext: Context = {
    systemPrompt: "Reply with one short loading message and nothing else.",
    messages: [{ role: "user", content: [{ type: "text", text: prompt(task) }], timestamp: Date.now() }],
  };
  const controller = new AbortController();
  generation?.abort();
  generation = controller;
  try {
    const response = await complete(model, aiContext, { apiKey: auth.apiKey, headers: auth.headers, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]) });
    const text = response.content.find((part) => part.type === "text")?.text;
    if (!text || controller.signal.aborted) return fallback();
    const value = message(text.split("\n")[0] ?? "");
    recent = [value, ...recent.filter((item) => item !== value)].slice(0, 5);
    return value;
  } catch {
    return fallback();
  }
}

export function initVibeManager(extensionContext: ExtensionContext, settings: VibeSettings): void {
  context = extensionContext;
  config = settings;
  streaming = false;
  currentText = "";
  recent = [];
  preparedNext = null;
  preparing = null;
  generation?.abort();
  stopAnimation();
  void prepareNext();
}

export function updateVibeSettings(settings: VibeSettings): void {
  const themeOrModelChanged = config?.theme !== settings.theme || config?.model !== settings.model || config?.mode !== settings.mode;
  config = settings;
  if (!settings.rainbow) stopAnimation();
  if (themeOrModelChanged) preparedNext = null;
}

async function prepareNext(): Promise<void> {
  if (!config?.theme || config.mode === "file") return;
  if (preparing) return preparing;
  const task = lastTask || "a new task";
  const run = (async () => {
    const value = await generate(task);
    preparedNext = value;
  })();
  preparing = run.finally(() => {
    if (preparing === run) preparing = null;
  });
  return preparing;
}

export function onVibeBeforeAgentStart(task: string, setWorkingMessage: (text?: string) => void): void {
  if (!config?.theme) return;
  lastTask = task;
  lastRefresh = Date.now();
  if (config.mode !== "file" && preparedNext) {
    emit(setWorkingMessage, preparedNext);
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
  const value = config?.mode === "file" ? nextFileVibe() : await generate(task);
  if (streaming || currentText) emit(setWorkingMessage, value);
}

export function onVibeAgentEnd(setWorkingMessage: (text?: string) => void): void {
  streaming = false;
  generation?.abort();
  stopAnimation();
  currentText = "";
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
    const values = (response.content.find((part) => part.type === "text")?.text ?? "").split(/\r?\n/).map(message).filter((value) => value !== "...");
    if (!values.length) return { success: false, count: 0, filePath, error: "No vibes generated" };
    mkdirSync(vibeDir(), { recursive: true });
    writeFileSync(filePath, values.join("\n") + "\n");
    if (fileTheme === theme) fileTheme = null;
    return { success: true, count: values.length, filePath };
  } catch (error) {
    return { success: false, count: 0, filePath, error: error instanceof Error ? error.message : "Generation failed" };
  }
}
