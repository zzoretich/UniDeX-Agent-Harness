// nodeResolver.ts — the one node-binary resolver for every spawn the plugin makes.
// Obsidian's renderer does not inherit the login-shell PATH, so bare "node" fails
// ENOENT on most machines. Order (contract §5):
//   1. settings.nodePath          (if it still exists)
//   2. agenticos.json "node"      (what `aos init` resolved for the hooks)
//   3. known install locations    (+ ~/.nvm newest first, ~/.volta, fnm default alias)
//   4. one login-shell probe      ($SHELL -lic 'command -v node'), saved to settings.nodePath
//   5. "node"                     (let spawn try the system PATH)
// The probe is slow (~200-800 ms) and runs at most once per process; a success is
// persisted by the caller so it never runs again on that install.
import * as path from "path";
import { env as hostEnv, execFileSync, fs } from "../host";
import { readAgenticosJson } from "./aosConfig";
import type { AgenticOSSettings } from "../settingsDefaults";

export interface NodeResolverDeps {
  existsSync: (p: string) => boolean;
  readdirSync: (p: string) => string[];
  execFileSync: (file: string, args: string[], opts: { encoding: "utf8"; timeout: number }) => string;
  homedir: () => string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  agenticosNode: (configDir?: string) => string | null;   // configDir: the settings-level Claude config dir, when set (Ruling A18)
}

const DEFAULT_DEPS: NodeResolverDeps = {
  existsSync: (p) => { try { return fs.existsSync(p); } catch { return false; } },
  readdirSync: (p) => fs.readdirSync(p),
  execFileSync: (file, args, opts) => execFileSync(file, args, opts),
  homedir: () => hostEnv.homedir(),
  // Getters: read from the host when a resolve runs, never when this module loads.
  get platform() { return hostEnv.platform() as NodeJS.Platform; },
  get env() { return { SHELL: hostEnv.get("SHELL") }; },
  agenticosNode: (configDir) => readAgenticosJson(configDir)?.node ?? null,
};

export function nodeCandidates(d: Pick<NodeResolverDeps, "homedir" | "platform" | "readdirSync">): string[] {
  const home = d.homedir();
  const out: string[] = [];
  if (d.platform === "darwin") out.push("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node");
  else if (d.platform === "linux") out.push("/usr/local/bin/node", "/usr/bin/node", "/snap/bin/node");
  // win32 adds no absolute candidates: it falls through to the login-shell probe and then to the
  // bare name "node", which spawn resolves on the system PATH (cli/aos.js refuses win32 in v1).
  const nvmRoot = path.join(home, ".nvm", "versions", "node");
  let nvm: string[] = [];
  // Newest first, numerically: a plain .sort() is lexicographic and would rank v9 above v22.
  try { nvm = d.readdirSync(nvmRoot).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })); } catch { nvm = []; }
  for (const v of nvm) out.push(path.join(nvmRoot, v, "bin", "node"));
  out.push(path.join(home, ".volta", "bin", "node"));
  out.push(path.join(home, ".local", "share", "fnm", "aliases", "default", "bin", "node"));
  return out;
}

let loginShellProbed = false;
export function resetProbeForTests(): void { loginShellProbed = false; }

export function resolveNodeBinary(settings: AgenticOSSettings, deps: Partial<NodeResolverDeps> = {}): string {
  const d: NodeResolverDeps = { ...DEFAULT_DEPS, ...deps };
  const present = (p: string | null | undefined): p is string => !!p && d.existsSync(p);

  if (present(settings.nodePath)) return settings.nodePath;
  // A settings-level config dir (the Dock-launched Obsidian case) names where agenticos.json lives (Ruling A6/A18).
  const fromJson = d.agenticosNode(settings.claudeConfigDir || undefined);
  if (present(fromJson)) return fromJson;
  for (const c of nodeCandidates(d)) if (d.existsSync(c)) return c;

  if (!loginShellProbed) {
    loginShellProbed = true;
    const shell = d.env.SHELL || "/bin/sh";
    try {
      const out = d.execFileSync(shell, ["-lic", "command -v node"], { encoding: "utf8", timeout: 5000 });
      const last = out.trim().split("\n").pop() || "";
      if (last.startsWith("/") && d.existsSync(last)) {
        settings.nodePath = last;
        return last;
      }
    } catch { /* no login shell, or no node in it */ }
  }
  return "node";
}
