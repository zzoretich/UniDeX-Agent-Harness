import { App, Notice, TFile } from "obsidian";
import * as path from "path";
import { env, fs, spawn } from "../host";
import { CaptureModal } from "../ui/CaptureModal";
import { RememberModal } from "../ui/RememberModal";
import { PatternModal } from "../ui/PatternModal";
import { MemoryType } from "./memoryWriter";
import { invocation, readAgenticosJson, sessionHosts } from "./aosConfig";

// Obsidian's spawn'd subprocesses don't inherit the user's shell PATH, so bare
// "node" fails ENOENT. Search common install locations.
export function resolveExe(name: string): string {
  if (name.startsWith("/")) return name;
  const candidates: string[] = [];
  if (env.platform() === "darwin") {
    candidates.push(
      `/opt/homebrew/bin/${name}`,   // Apple Silicon Homebrew
      `/usr/local/bin/${name}`,       // Intel Homebrew / Node installer
      `/usr/bin/${name}`,
    );
  } else if (env.platform() === "linux") {
    candidates.push(
      `/usr/local/bin/${name}`,
      `/usr/bin/${name}`,
      `/snap/bin/${name}`,
    );
  }
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return name; // last resort — let spawn try the system PATH
}

// Spawn context set by main.ts at load (resolved node binary + vault root). executeCommand
// keeps its (app, cmd) signature because ⌘K and the command deck call it without plugin access.
let spawnCtx: { node: string; vaultRoot: string } | null = null;
export function setSpawnContext(ctx: { node: string; vaultRoot: string }): void { spawnCtx = ctx; }

// remember / pattern: their own targets, the same as the in-session /remember and /pattern (spec 2026-09-24-hud-deck-fixes D4, D5).
export type CommandKind = "clipboard" | "openFile" | "exec" | "capture" | "remember" | "pattern" | "openView";

export interface SlashCommand {
  name: string;
  kind: CommandKind;
  desc: string;
  // openFile
  path?: string;
  // exec
  cmd?: string;
  args?: string[];
  background?: boolean;
  // capture
  captureType?: MemoryType;
  // openView
  viewType?: string;
}

export const COMMAND_REGISTRY: SlashCommand[] = [
  { name: "/scan",           kind: "exec",      desc: "Refresh vault snapshot.json", cmd: "node", args: ["brain/scripts/scan-vault.js"] },
  // --local: the provider writes it (reasoner role, capped by reasoner.perCallUsd / perDayUsd); without a flag the
  // script only prints a prompt meant for a session (spec 2026-09-24-hud-deck-fixes D2).
  { name: "/reflect-week",   kind: "exec",      desc: "Write this week's reflection (reasoner model)", cmd: "node", args: ["brain/scripts/sdk/reflect-week.js", "--local"] },
  { name: "/brain",          kind: "openFile",  desc: "Open BRAIN.md", path: "brain/_index/BRAIN.md" },
  { name: "/remember",       kind: "remember",  desc: "Add a note to SESSION.md (#promote)" },
  { name: "/feedback",       kind: "capture",   desc: "New feedback memory", captureType: "feedback" },
  { name: "/project",        kind: "capture",   desc: "New project memory", captureType: "projects" },
  { name: "/pattern",        kind: "pattern",   desc: "New pattern in brain/patterns/" },
  { name: "/wrap",           kind: "clipboard", desc: "Run session-end protocol — copies" },
  { name: "/ask-brain",      kind: "clipboard", desc: "Ask the vault — copies" },
];

export async function executeCommand(app: App, cmd: SlashCommand): Promise<void> {
  switch (cmd.kind) {
    case "clipboard": {
      // The palette lists Claude Code names; copy what this user's first host takes (Codex: $agenticos:<name>).
      const cfg = readAgenticosJson();
      const text = invocation(cmd.name.replace(/^\//, ""), sessionHosts(cfg)[0] || "claude", cfg);
      await navigator.clipboard.writeText(text);
      new Notice(`Copied: ${text}`);
      return;
    }

    case "openFile": {
      if (!cmd.path) return;
      const file = app.vault.getAbstractFileByPath(cmd.path);
      if (file instanceof TFile) {
        await app.workspace.getLeaf("tab").openFile(file);
      } else {
        new Notice(`Not found: ${cmd.path}`);
      }
      return;
    }

    case "capture": {
      new CaptureModal(app, { prefillType: cmd.captureType || "feedback" }).open();
      return;
    }

    case "remember": {
      new RememberModal(app).open();
      return;
    }

    case "pattern": {
      new PatternModal(app).open();
      return;
    }

    case "exec": {
      if (!cmd.cmd) {
        new Notice(`✗ ${cmd.name}: no shell command configured`);
        return;
      }
      try {
        const adapter = app.vault.adapter as unknown as { getBasePath?: () => string };
        const base = adapter.getBasePath ? adapter.getBasePath() : env.cwd();
        const root = spawnCtx?.vaultRoot ?? base;
        const args = (cmd.args || []).map((a) =>
          a.startsWith("/") || a.startsWith("-") || a.startsWith("--") ? a : path.join(root, a)
        );
        const exe = cmd.cmd === "node" && spawnCtx ? spawnCtx.node : resolveExe(cmd.cmd);
        new Notice(`▶ ${cmd.name}`);
        const child = spawn(exe, args, { cwd: root, detached: !!cmd.background });
        let out = "", err = "";
        child.stdout?.on("data", (b) => { out += b; });
        child.stderr?.on("data", (b) => { err += b; });
        if (cmd.background) {
          child.unref();
          setTimeout(() => new Notice(`${cmd.name} running in background`), 200);
        } else {
          child.on("close", (code) => {
            if (code === 0) {
              // Runtime scripts report on stderr (reflect-week's "wrote brain/reflections/…"), so an empty stdout
              // falls back to it (spec 2026-09-24-hud-deck-fixes D3).
              const tail = (out.trim() || err.trim()).split("\n").pop() || "ok";
              new Notice(`✓ ${cmd.name}: ${tail.slice(0, 120)}`);
            } else {
              const tail = (err || out).trim().split("\n").pop() || `exit ${code}`;
              new Notice(`✗ ${cmd.name}: ${tail.slice(0, 120)}`);
            }
          });
          child.on("error", (e) => { new Notice(`✗ ${cmd.name}: ${e.message}`); });
        }
      } catch (e) {
        new Notice(`✗ ${cmd.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

    case "openView": {
      if (!cmd.viewType) return;
      const { workspace } = app;
      const existing = workspace.getLeavesOfType(cmd.viewType);
      if (existing.length > 0) { workspace.revealLeaf(existing[0]); return; }
      const leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: cmd.viewType, active: true });
      workspace.revealLeaf(leaf);
      return;
    }
  }
}
