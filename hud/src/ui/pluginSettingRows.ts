import { Notice, Setting } from "obsidian";
import type AgenticOSPlugin from "../../main";
import type { AgenticOSSettings } from "../settingsDefaults";
import { resolveNodeBinary, resetProbeForTests, nodeCandidates } from "../data/nodeResolver";
import { readAgenticosJson, claudeConfigDir as envClaudeConfigDir } from "../data/aosConfig";
import { setSpawnContext } from "../data/commandRegistry";
import { decideVaultRoot } from "../data/vaultRootField";
import { failureText } from "../data/aosRun";
import { resultSummary, valueArg } from "../data/settingsModel";
import type { SetResult } from "../data/settingsModel";
import { pluginChoices, pluginStep, parseShells } from "../data/pluginChoices";
import type { PluginChoiceEnv } from "../data/pluginChoices";
import { env, fs } from "../host";

function isDirectory(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

export interface PluginRowsHandle {
  /** Kept for callers' teardown; every row now saves on pick, so there is nothing left to commit. */
  commit(): Promise<void>;
}

function basePath(plugin: AgenticOSPlugin): string {
  const adapter = plugin.app.vault.adapter as unknown as { getBasePath?: () => string };
  return adapter.getBasePath ? adapter.getBasePath() : env.cwd();
}

/** The machine facts the pickers offer (spec 2026-09-24-settings-pickers D7), read fresh on every render. */
function choiceEnv(plugin: AgenticOSPlugin): PluginChoiceEnv {
  const cfg = readAgenticosJson();
  let shells: string[] = [];
  try { shells = parseShells(fs.readFileSync("/etc/shells", "utf8")); } catch { /* no /etc/shells: system default only */ }
  return {
    vaultBase: basePath(plugin), agenticosVault: cfg?.vault ?? null,
    envConfigDir: env.get("CLAUDE_CONFIG_DIR") ?? null, agenticosConfigDir: cfg?.claudeConfigDir ?? null, defaultConfigDir: envClaudeConfigDir(),
    home: env.homedir(), nodeCandidates: nodeCandidates({ homedir: () => env.homedir(), platform: env.platform() as NodeJS.Platform, readdirSync: (p) => fs.readdirSync(p) }),
    exists: (p) => { try { return fs.existsSync(p); } catch { return false; } }, shells, envShell: env.get("SHELL") ?? null,
  };
}

type Key = keyof AgenticOSSettings;

/**
 * The plugin's own settings (data.json), rendered with Obsidian's Setting component into any container. Obsidian's
 * settings pane and the Workbench Settings tab both call this, so the two never drift (spec 2026-09-24-settings-tab
 * D11). Every row is a toggle, a picker (with − / + on numbers) or a button — no text boxes (settings-pickers D1, D7,
 * D9). `rerender` redraws the caller after a change that alters other rows.
 */
export function renderPluginSettings(containerEl: HTMLElement, plugin: AgenticOSPlugin, rerender: () => void): PluginRowsHandle {
  const choices = choiceEnv(plugin);
  const save = async (key: Key, value: string | number, after?: () => void) => {
    (plugin.settings as unknown as Record<string, unknown>)[key] = value;
    await plugin.saveSettings();
    after?.();
    rerender();
  };

  /** A picker for `key`, with − / + around it when the key is a number (D9). */
  const picker = (s: Setting, key: Key, onPick: (value: string | number) => void | Promise<void>) => {
    const current = plugin.settings[key] as string | number;
    const opts = pluginChoices(key, current, choices) ?? [];
    const step = (dir: -1 | 1) => (typeof current === "number" ? pluginStep(key, current, dir) : null);
    const stepper = (dir: -1 | 1) => s.addExtraButton((b) => {
      const next = step(dir);
      b.setIcon(dir === -1 ? "minus" : "plus").setTooltip(next === null ? (dir === -1 ? "lowest preset" : "highest preset") : `${dir === -1 ? "Lower" : "Raise"} to ${next}`)
        .setDisabled(next === null).onClick(() => { if (next !== null) void onPick(next); });
    });
    if (typeof current === "number") stepper(-1);
    s.addDropdown((d) => {
      opts.forEach((o, i) => d.addOption(String(i), o.label));
      d.setValue(String(Math.max(0, opts.findIndex((o) => o.value === current))));
      d.onChange((i) => { const o = opts[Number(i)]; if (o && o.value !== current) void onPick(o.value); });
    });
    if (typeof current === "number") stepper(1);
  };

  new Setting(containerEl).setName("General").setHeading();

  new Setting(containerEl)
    .setName("Status bar enabled")
    .setDesc("Show live agent/run telemetry in the status bar. Consumed by Plugin.rebuildStatusBar(), which reruns immediately when this changes.")
    .addToggle((t) =>
      t.setValue(plugin.settings.statusBarEnabled).onChange(async (v) => {
        plugin.settings.statusBarEnabled = v;
        await plugin.saveSettings();
        plugin.rebuildStatusBar();
      })
    );

  new Setting(containerEl)
    .setName("Auto-open sidebar on start")
    .setDesc("Open the compact HUD in the right sidebar whenever the app starts. Checked once in Plugin.onload() on workspace layout-ready — takes effect on the next restart, not immediately.")
    .addToggle((t) =>
      t.setValue(plugin.settings.autoOpenSidebarOnStart).onChange(async (v) => {
        plugin.settings.autoOpenSidebarOnStart = v;
        await plugin.saveSettings();
      })
    );

  picker(new Setting(containerEl)
    .setName("Poll interval")
    .setDesc("How often the local watcher polls brain/_index/agent-runs/ for new run events. Consumed by LiveRunsWatcher, rebuilt immediately via Plugin.rebindLiveSources(); its events feed ChatTab's live tail."),
  "liveTailPollMs", (v) => save("liveTailPollMs", v, () => plugin.rebindLiveSources()));

  new Setting(containerEl).setName("Paths").setHeading();

  picker(new Setting(containerEl)
    .setName("Vault root")
    .setDesc("The vault used for spawns, the live-runs watcher and orphan sweep, brain/config.json, provider-state.json and persona/IDENTITY.md. Pulse/Runs/Memory/Spaces and the status bar always render the vault the app opened, regardless of this setting. Consumed by Plugin.vaultRoot() on every read/spawn, from the moment it is picked."),
  "vaultRoot", async (v) => {
    // decideVaultRoot still vets the pick (a vault that has since moved is refused, a different vault explains itself).
    const d = decideVaultRoot({ typed: String(v), saved: plugin.settings.vaultRoot, basePath: basePath(plugin), isDirectory });
    if (d.notice) new Notice(d.notice, d.noticeMs);
    if (d.action === "none" || d.action === "reject") { rerender(); return; }
    // commandRegistry captured the context once in onload(); refresh it or ⌘K and the command deck keep spawning in
    // the old vault until Obsidian is reloaded.
    await save("vaultRoot", d.value, () => setSpawnContext({ node: plugin.nodeBin(), vaultRoot: plugin.vaultRoot() }));
  });

  picker(new Setting(containerEl)
    .setName("Claude config dir")
    .setDesc("Where Claude Code keeps projects/ transcripts and agents/. Auto uses agenticos.json, then $CLAUDE_CONFIG_DIR, then ~/.claude. Consumed by Plugin.claudeConfigDir() (Pulse backfill count)."),
  "claudeConfigDir", (v) => save("claudeConfigDir", v));

  const nodeSetting = new Setting(containerEl)
    .setName("Node binary")
    .setDesc("The node used to spawn brain scripts. Auto resolves it (agenticos.json, common install locations, then one login-shell probe whose result is saved here); Probe re-runs that now. Consumed by Plugin.nodeBin() on every spawn.");
  picker(nodeSetting, "nodePath", (v) => save("nodePath", v, () => setSpawnContext({ node: plugin.nodeBin(), vaultRoot: plugin.vaultRoot() })));
  nodeSetting.addButton((b) =>
    b.setButtonText("Probe").setTooltip("Re-run the resolver now and save what it finds").onClick(async () => {
      resetProbeForTests();
      const before = plugin.settings.nodePath;
      plugin.settings.nodePath = "";
      const found = resolveNodeBinary(plugin.settings);
      if (found === "node") plugin.settings.nodePath = before;
      else plugin.settings.nodePath = found;
      await plugin.saveSettings();
      setSpawnContext({ node: plugin.nodeBin(), vaultRoot: plugin.vaultRoot() });
      new Notice(found === "node" ? "node not found — pick one of the listed binaries" : `node: ${found}`);
      rerender();
    })
  );

  new Setting(containerEl).setName("Terminal").setHeading();

  picker(new Setting(containerEl)
    .setName("Shell")
    .setDesc("Default shell for new terminal sessions; system default is $SHELL. Read once by Plugin.onload() to build the shared TerminalPool — applies after the app restarts."),
  "terminalShell", (v) => save("terminalShell", v));

  picker(new Setting(containerEl)
    .setName("Working directory")
    .setDesc("Default working directory for new terminal sessions. Read once by Plugin.onload() to build the shared TerminalPool — applies after the app restarts."),
  "terminalCwd", (v) => save("terminalCwd", v));

  picker(new Setting(containerEl)
    .setName("Font size")
    .setDesc("xterm.js font size for new terminal sessions. Consumed by TerminalPanel.createBinding() when a session is first opened — already-open sessions keep their size until reopened."),
  "terminalFontSize", (v) => save("terminalFontSize", v));

  picker(new Setting(containerEl)
    .setName("Scrollback")
    .setDesc("xterm.js scrollback buffer for new terminal sessions. Consumed by TerminalPanel.createBinding() when a session is first opened — already-open sessions are unaffected until reopened."),
  "terminalScrollback", (v) => save("terminalScrollback", v));

  return { commit: async () => {} };
}

/**
 * One system setting written through `aos config set <key> <value> --json` (spec 2026-09-24-settings-tab D3), with the
 * outcome as a Notice: the change and its effects, or the CLI's own refusal. Returns the result on success, else null.
 * A telemetry change rebinds the live watcher at once (it decides whether agent-runs/live is created).
 */
export async function setSystemSetting(plugin: AgenticOSPlugin, key: string, value: unknown): Promise<SetResult | null> {
  const r = await plugin.aosJson<SetResult>(["config", "set", key, valueArg(value), "--json"]);
  if (r.code !== 0 || !r.json) {
    new Notice(`${key} not changed: ${r.code === 0 ? "unexpected reply from aos config" : failureText(r)}`, 8000);
    return null;
  }
  new Notice(resultSummary(r.json), 6000);
  if (key === "telemetry.enabled") plugin.rebindLiveSources();
  return r.json;
}
