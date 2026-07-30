# StickyBar

Input bar extension for [pi](https://github.com/badlogic/pi-mono) coding agent.

## Preview

![StickyBar preview](https://raw.githubusercontent.com/jekatigr//pi-stickybar/main/docs/preview.gif)

## Features

- **Fixed editor** - prompt is always visible
- **Two configurable status rows** with model, git state and more, check table below
- **Last-prompt preview** under the input prompt line
- **Themed working vibes:** generated realtime based on your input or loaded from a local file, with optional rainbow animation.

## Installation

```bash
pi install npm:pi-stickybar
```

Restart pi after installation or call `/reload`.

## Configuration

The extension has opiniated defaults, but it also configurable via `settings.json`

Put settings under a single `stickybar` object. Pi reads global settings first, then project settings, so `.pi/settings.json` overrides `~/.pi/agent/settings.json`.

Full configuration example:

```json
{
  "stickybar": {
    "fixedEditor": true,
    "mouseScroll": true,
    "showLastPrompt": true,

    "top": [
      "git",
      "context_pct",
      "token_in",
      "token_out",
      "cost",
      "time_spent"
    ],

    "bottom": [
      "model",
      "thinking",
      "path",
      "extension_statuses"
    ],

    "options": {
      "path": { "mode": "basename", "maxLength": 32 },
      "git": {
        "polling": "full",
        "showBranch": true,
        "showStaged": true,
        "showUnstaged": true,
        "showUntracked": true
      },
      "time": { "format": "24h", "showSeconds": false }
    },

    "vibe": {
      "theme": "evil corporation",
      "mode": "generate",
      "model": "openai-codex/gpt-5.4-mini",
      "rainbow": true,
      "fallback": "Working",
      "refreshInterval": 30,
      "prompt": "Generate a {theme} loading message for: {task}. {exclude}",
      "maxLength": 65,
      "lookback": 30
    },

    "chatNavigation": {
      "previousKey": "ctrl+alt+up",
      "nextKey": "ctrl+alt+down"
    }
  }
}
```

### Status items

`top` and `bottom` are ordered arrays. An item can appear only once, and unknown IDs are ignored.

| Item | Description | Example |
| --- | --- | --- |
| `model` | Current model in use | `gpt-5.4-mini` |
| `thinking` | Reasoning/thinking level | `medium` |
| `path` | Current file path (see options) | `src/index.ts` |
| `git` | Git branch + working-tree state | `main ⇡3 ✗2 ?1` |
| `context_pct` | Context window usage percentage | `45%` |
| `context_total` | Total context tokens used | `12,450 tok` |
| `token_in` | Input tokens for current turn | `3,200` |
| `token_out` | Output tokens for current turn | `840` |
| `token_total` | Total tokens (in + out) | `4,040` |
| `cost` | Estimated cost of current session | `$0.012` |
| `time_spent` | Elapsed time for current turn | `3s` |
| `time` | Current clock time | `14:35` |
| `session` | Session identifier or name | `sess-abc123` |
| `hostname` | Machine hostname | `my-laptop` |
| `cache_read` | Cache read hits | `128` |
| `cache_write` | Cache write hits | `35` |
| `extension_statuses` | All published extension statuses | `ci: passing · deploy: ready` |

### Path options

Configure how file paths are displayed via `options.path`:

| Option | Values | Description |
| --- | --- | --- |
| `mode` | `basename`, `abbreviated`, `full` | How the path is rendered. `basename` shows only the filename (`index.ts`). `abbreviated` keeps the full path but truncates from the start with `…` when it exceeds `maxLength`. `full` always shows the complete absolute path. |
| `maxLength` | number (default: 32) | Maximum length for `abbreviated` mode. Longer paths are truncated from the beginning and prefixed with `…`. |

### Git polling options

Configure git status detail via `options.git`:

| Option | Values | Description |
| --- | --- | --- |
| `polling` | `full`, `branch`, `off` | How much git info to gather. `full` polls for branch name plus staged, unstaged, and untracked counts. `branch` shows only the current branch name without scanning working-tree changes. `off` skips local polling entirely and relies on whatever branch info pi provides. |
| `showBranch` | boolean (default: true) | Include the branch name in the segment. |
| `showStaged` | boolean (default: true) | Show the count of staged changes (`⇡`). |
| `showUnstaged` | boolean (default: true) | Show the count of unstaged changes (`✗`). |
| `showUntracked` | boolean (default: true) | Show the count of untracked files (`?`). |

### Custom status items

Use `custom:<id>` in a row and declare the matching item in `customItems`:

```json
{
  "stickybar": {
    "top": ["model", "path", "custom:ci", "git"],
    "bottom": ["context_pct", "extension_statuses"],
    "customItems": [
      {
        "id": "ci",
        "statusKey": "ci-status",
        "prefix": "CI",
        "hideWhenMissing": true,
        "excludeFromExtensionStatuses": true
      }
    ]
  }
}
```

Extensions publish a value with:

```ts
ctx.ui.setStatus("ci-status", "passing");
```

### Chat navigation (fixed editor only)

When `fixedEditor` is on, `chatNavigation.previousKey`/`nextKey` jump the scrollable transcript to the previous/next user prompt (a single agent turn can render several assistant/tool-call components in a row, so only user prompts are used as jump targets - assistant replies are skipped). Defaults are `ctrl+alt+up` / `ctrl+alt+down`, which avoid Pi's existing `ctrl+o` and `ctrl+p` bindings. Once there's no earlier/later prompt left, the shortcut lands on the very start/end of the thread instead of doing nothing.

Some terminals and IDE-embedded terminals (e.g. IntelliJ's terminal tool window) reserve modified arrow keys for their own scrollback or do not forward them to Pi. If a shortcut appears to "just scroll" instead of jumping to a message, override it with another key combination in `chatNavigation`.

If the defaults collide with something in your setup, override them:

```json
{
  "stickybar": {
    "chatNavigation": {
      "previousKey": "ctrl+alt+t",
      "nextKey": "ctrl+alt+y"
    }
  }
}
```

Avoid `ctrl+[` (identical to plain `Escape` on every ANSI terminal - Pi uses `Escape` to cancel/close overlays) and `ctrl+]` (already bound by Pi's editor to "jump forward to character"). Set a key to `null` or `""` to disable it entirely.

### Working vibes

Manage vibes from pi with `/stickybar vibe`:

```text
/stickybar                    Show current status
/stickybar vibe               Show vibe status
/stickybar vibe pirate        Enable a theme
/stickybar vibe off           Disable vibes
/stickybar vibe rainbow on    Enable rainbow animation
/stickybar vibe mode file     Use ~/.pi/agent/vibes/<theme>.txt
/stickybar vibe model provider/model
/stickybar vibe generate evil cat corporation 100
```

`generate` mode requests a short message from the configured model while Pi is working. `file` mode rotates through messages in `~/.pi/agent/vibes/<theme>.txt` and does not make a model request.

In `generate` mode, the last `lookback` messages (default `30`) are fed back to the model as an exclusion list to reduce repeats, and are persisted per-theme to `~/.pi/agent/vibes/<theme>.history.json` so the exclusion list survives across sessions. Loading/saving this history is fire-and-forget and never blocks the UI. Set `lookback` to `0` to disable both the exclusion list and persistence.

> This project is a rework of [pi-powerline-footer](https://github.com/nicobailon/pi-powerline-footer) with simplified approach to customization and limited feature list.
