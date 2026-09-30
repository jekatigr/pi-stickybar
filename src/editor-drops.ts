import { fileURLToPath } from "node:url";

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

function bracketedPasteContent(data: string): string | null {
  if (!data.startsWith(BRACKETED_PASTE_START) || !data.endsWith(BRACKETED_PASTE_END)) return null;
  return data.slice(BRACKETED_PASTE_START.length, -BRACKETED_PASTE_END.length);
}

/**
 * Converts a terminal file drop (a file:// URI list, commonly sent as
 * bracketed paste) to space-separated native paths. Returns null for normal
 * typing and ordinary pasted text so the editor can handle those unchanged.
 */
export function droppedPathTextFromInput(data: string): string | null {
  const content = bracketedPasteContent(data) ?? data;
  const entries = content
    .split(/\r?\n|\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !entry.startsWith("#"));

  if (entries.length === 0 || entries.some((entry) => !entry.startsWith("file://"))) return null;

  try {
    return entries.map((entry) => fileURLToPath(entry)).join(" ");
  } catch {
    return null;
  }
}

/** Preserve bracketed-paste semantics when replacing a dropped URI list. */
export function replaceDroppedPathInput(original: string, paths: string): string {
  return original.startsWith(BRACKETED_PASTE_START) ? `${BRACKETED_PASTE_START}${paths}${BRACKETED_PASTE_END}` : paths;
}
