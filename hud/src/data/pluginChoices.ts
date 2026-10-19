// pluginChoices.ts — the presets for the plugin's own settings (data.json), so every row in Obsidian's settings pane
// and the Workbench's WORKBENCH section is a toggle, a picker or a button (spec 2026-09-24-settings-pickers D7).
// Pure over an injected environment so node:test covers it. "" is the plugin's own "auto" for every path setting, and
// the current value is always offered, marked "(custom)" when it is none of the presets — never dropped.
import * as path from "path";
import { stepIn } from "./settingsModel";

export interface PluginChoiceEnv {
  vaultBase: string;                 // this Obsidian vault's folder
  agenticosVault: string | null;     // `vault` in agenticos.json
  envConfigDir: string | null;       // $CLAUDE_CONFIG_DIR
  agenticosConfigDir: string | null; // `claudeConfigDir` in agenticos.json
  defaultConfigDir: string;          // aosConfig.claudeConfigDir(): $CLAUDE_CONFIG_DIR, else the host's default folder
  home: string;
  nodeCandidates: string[];          // nodeResolver.nodeCandidates()
  exists: (p: string) => boolean;
  shells: string[];                  // /etc/shells
  envShell: string | null;           // $SHELL
}
export interface PluginOption { value: string | number; label: string }

export const POLL_MS = [100, 200, 300, 500, 1000, 2000, 5000];
export const FONT_PX = [10, 11, 12, 13, 14, 15, 16, 18, 20];
export const SCROLLBACK = [1000, 2000, 5000, 10000, 50000, 100000];
const NUMBERS: Record<string, { presets: number[]; label: (n: number) => string }> = {
  liveTailPollMs: { presets: POLL_MS, label: (n) => `${n} ms` },
  terminalFontSize: { presets: FONT_PX, label: (n) => `${n} px` },
  terminalScrollback: { presets: SCROLLBACK, label: (n) => `${n.toLocaleString("en-US")} lines` },
};

/** A path for display: the home folder as `~`. */
export function tildify(p: string, home: string): string {
  return home && (p === home || p.startsWith(`${home}${path.sep}`)) ? `~${p.slice(home.length)}` : p;
}

function withCurrent(opts: PluginOption[], current: string | number, label: (v: string | number) => string): PluginOption[] {
  const out: PluginOption[] = [];
  for (const o of opts) if (!out.some((x) => x.value === o.value)) out.push(o);   // dedupe, first label wins
  if (!out.some((o) => o.value === current)) out.push({ value: current, label: `${label(current)} (custom)` });
  return out;
}

/** The picker's options for one plugin setting, or null when the key is not a picked one (a toggle). */
export function pluginChoices(key: string, current: string | number, env: PluginChoiceEnv): PluginOption[] | null {
  const t = (p: string) => tildify(p, env.home);
  const num = NUMBERS[key];
  if (num) return withCurrent(num.presets.map((n) => ({ value: n, label: num.label(n) })), current, (v) => num.label(Number(v)));
  const str = (v: string | number) => t(String(v));
  switch (key) {
    case "vaultRoot": {
      const opts: PluginOption[] = [{ value: "", label: `this vault (${t(env.vaultBase)})` }];
      if (env.agenticosVault && path.resolve(env.agenticosVault) !== path.resolve(env.vaultBase)) opts.push({ value: env.agenticosVault, label: `agenticos.json vault (${t(env.agenticosVault)})` });
      return withCurrent(opts, current, str);
    }
    case "claudeConfigDir": {
      const opts: PluginOption[] = [{ value: "", label: "auto (agenticos.json, then $CLAUDE_CONFIG_DIR, then ~/.claude)" }];
      for (const d of [env.agenticosConfigDir, env.envConfigDir, env.defaultConfigDir]) if (d) opts.push({ value: d, label: t(d) });
      return withCurrent(opts, current, str);
    }
    case "nodePath": {
      const opts: PluginOption[] = [{ value: "", label: "auto (resolve on each start)" }];
      for (const c of env.nodeCandidates) if (env.exists(c)) opts.push({ value: c, label: t(c) });
      return withCurrent(opts, current, str);
    }
    case "terminalShell": {
      const opts: PluginOption[] = [{ value: "", label: `system default (${env.envShell ?? "$SHELL"})` }];
      for (const sh of env.shells) opts.push({ value: sh, label: sh });
      return withCurrent(opts, current, str);
    }
    case "terminalCwd":
      return withCurrent([{ value: "", label: "vault root" }, { value: env.home, label: "home (~)" }], current, str);
    default:
      return null;
  }
}

/** D9 for the plugin's number rows: the next preset below or above, null at the ends or for a non-number key. */
export function pluginStep(key: string, current: number, dir: -1 | 1): number | null {
  const num = NUMBERS[key];
  return num ? stepIn(num.presets, current, dir) : null;
}

/** /etc/shells → the shells in it (comments and blanks dropped). */
export function parseShells(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}
