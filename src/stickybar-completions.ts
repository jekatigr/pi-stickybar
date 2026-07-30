import type { AutocompleteItem } from "@earendil-works/pi-tui";

interface Hint extends AutocompleteItem {
  value: string;
  label: string;
  description: string;
}

const VIBE_ACTIONS: Hint[] = [
  { value: "off", label: "off", description: "Disable themed working messages" },
  { value: "rainbow", label: "rainbow", description: "Toggle or set rainbow animation" },
  { value: "printing", label: "printing", description: "Toggle or set character-by-character message reveal" },
  { value: "mode", label: "mode", description: "Choose generated or file-backed messages" },
  { value: "model", label: "model", description: "Set the model used to generate messages" },
  { value: "generate", label: "generate", description: "Create a reusable vibe file for a theme" },
];

const TOGGLE_VALUES: Hint[] = [
  { value: "on", label: "on", description: "Enable this effect" },
  { value: "off", label: "off", description: "Disable this effect" },
];

const MODE_VALUES: Hint[] = [
  { value: "generate", label: "generate", description: "Generate messages while Pi is working" },
  { value: "file", label: "file", description: "Read messages from ~/.pi/agent/vibes" },
];

function matching(items: readonly Hint[], prefix: string): Hint[] | null {
  const matches = items.filter((item) => item.value.startsWith(prefix.toLowerCase()));
  return matches.length ? matches : null;
}

/** Completion hints for `/stickybar` without inventing theme or model names. */
export function getStickybarArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const trailingSpace = /\s$/.test(prefix);
  const words = prefix.trim().split(/\s+/).filter(Boolean);

  if (!words.length) {
    return [{ value: "vibe", label: "vibe", description: "Configure themed working messages" }];
  }
  const vibeHint = { value: "vibe", label: "vibe", description: "Configure themed working messages" };
  if (words.length === 1 && !trailingSpace) return matching([vibeHint], words[0]);
  if (words[0] !== "vibe") return null;
  if (words.length === 1) return VIBE_ACTIONS;

  const action = words[1]?.toLowerCase();

  // Partial action word — match against known actions
  if (!trailingSpace && words.length === 2) {
    return matching(VIBE_ACTIONS, action);
  }

  const valuePrefix = trailingSpace && words.length === 2 ? "" : words[2] ?? "";
  if (action === "rainbow" || action === "printing") return matching(TOGGLE_VALUES, valuePrefix);
  if (action === "mode") return matching(MODE_VALUES, valuePrefix);
  if (action === "model") {
    return [{ value: "provider/model", label: "provider/model", description: "Provider and model ID" }];
  }
  if (action === "generate") {
    return [{ value: "theme", label: "theme", description: "Theme name; optional count follows" }];
  }
  return null;
}
