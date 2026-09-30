import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseStickybarConfig } from "../src/stickybar-config.ts";
import { readStickybarSettings, writeStickybarConfig } from "../src/settings.ts";

function withTemporarySettings(run: (paths: { agentDir: string; projectDir: string }) => void): void {
  const root = mkdtempSync(join(tmpdir(), "stickybar-settings-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    run({ agentDir, projectDir });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
}

test("project settings recursively override global StickyBar settings", () => {
  withTemporarySettings(({ agentDir, projectDir }) => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      stickybar: {
        showLastPrompt: true,
        options: { git: { polling: "branch", showBranch: true, showUntracked: true } },
        vibe: { theme: "pirate", rainbow: false },
        top: ["git", "model"],
      },
      unrelatedGlobal: true,
    }));
    writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({
      stickybar: {
        options: { git: { showUntracked: false } },
        vibe: { rainbow: true },
        top: ["path"],
      },
      unrelatedProject: true,
    }));

    assert.deepEqual(readStickybarSettings(projectDir), {
      stickybar: {
        showLastPrompt: true,
        options: { git: { polling: "branch", showBranch: true, showUntracked: false } },
        vibe: { theme: "pirate", rainbow: true },
        // Arrays are deliberately replaced rather than merged item-by-item.
        top: ["path"],
      },
      unrelatedGlobal: true,
      unrelatedProject: true,
    });
  });
});

test("writes StickyBar configuration to the layer that owns it", () => {
  withTemporarySettings(({ agentDir, projectDir }) => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ stickybar: { vibe: { theme: "global" } } }));
    writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ stickybar: { vibe: { theme: "project" } } }));
    const config = parseStickybarConfig({ vibe: { theme: "updated" } });

    assert.equal(writeStickybarConfig(projectDir, config), true);
    assert.equal(JSON.parse(readFileSync(join(projectDir, ".pi", "settings.json"), "utf8")).stickybar.vibe.theme, "updated");
    assert.equal(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).stickybar.vibe.theme, "global");
  });
});

test("writes globally when no project StickyBar configuration exists", () => {
  withTemporarySettings(({ agentDir, projectDir }) => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ unrelated: true }));
    const config = parseStickybarConfig({ vibe: { theme: "global-target" } });

    assert.equal(writeStickybarConfig(projectDir, config), true);
    assert.equal(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).stickybar.vibe.theme, "global-target");
  });
});
