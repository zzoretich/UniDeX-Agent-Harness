// The wizard's first step (phase 5, I4; install-import B1, B2): what `aos init` needs, checked the way `aos init` checks
// it, before anything is written. Node 20 or newer and uv are required; each missing one is a download the wizard runs
// itself (setup/toolchain.ts), so nothing needs Homebrew or a terminal. Ollama and its models are not needed by
// `aos init`, but background work runs on them, so each missing one is a warning with its download. claude and codex
// are the hosts, and optional: an install with neither waits for one. A tool already there at or above its version
// floor (the toolchain manifest) is used as it is. Each probe runs a program with a timeout and never through a shell;
// the probes are injected so the tests can stand in for the machine.

import * as path from "node:path";
import { BRAND } from "../../shared/brand";
import type { PreflightReport, SetupCheck, SetupCheckId } from "../../shared/ipc";
import { FIXES, fixBlocked } from "../policy/setup";
import { findOnPath, isExecutable } from "./env";
import { MANIFEST, OLLAMA_CURL, OLLAMA_URL, describeJob, macOSAtLeast, meetsFloor, ollamaModels, parseTags, privateNodeBinDir, versionIn, type Arch, type Manifest } from "./toolchain";

export { parseTags };

export interface ProbeResult { code: number | null; out: string }

interface Found { ok: boolean; detail: string; warn?: boolean; blocked?: string; noFix?: boolean }

export interface PreflightDeps {
  /** The PATH to look on (env.ts loginPath). */
  PATH: string;
  home: string;
  run: (file: string, args: string[], timeoutMs: number) => Promise<ProbeResult>;
  isExec?: (p: string) => boolean;
  exists: (p: string) => boolean;
  /** The pins and floors (the shipped toolchain manifest unless a test passes another). */
  manifest?: Manifest;
  arch?: Arch;
  /** The macOS version ("15.3.1"); "" when unknown. */
  macOS?: string;
  /** The Mac's memory in bytes, which picks the models (local-first A12). */
  totalmem: number;
  env?: NodeJS.ProcessEnv;
}

const LABELS: Record<SetupCheckId, string> = {
  node: "Node.js 20 or newer",
  uv: "uv",
  ollama: "Ollama",
  "ollama-models": "Ollama's models",
  claude: "Claude Code",
  "claude-login": "Claude Code login",
  codex: "Codex CLI",
  "codex-login": "Codex login",
};

/** "v22.12.0" → [22, 12]; "Python 3.13.1" → [3, 13]; null when there is no version in it. */
export function parseVersion(out: string): [number, number] | null {
  const m = /(\d+)\.(\d+)(?:\.\d+)?/.exec(out);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

const firstLine = (s: string): string => s.trim().split("\n")[0]?.trim().slice(0, 120) ?? "";

const ORDER: SetupCheckId[] = ["node", "uv", "ollama", "ollama-models", "claude", "claude-login", "codex", "codex-login"];
const REQUIRED: SetupCheckId[] = ["node", "uv"];

/** The Ollama apps a Mac may have, where the wizard and Ollama's own download put them. */
export function ollamaApps(home: string): string[] { return ["/Applications/Ollama.app", path.join(home, "Applications", "Ollama.app")]; }

/** The report the page shows, the node `aos init` will run with, and the Ollama app found (main keeps both; the page never names a program). */
export async function runPreflight(d: PreflightDeps): Promise<{ report: PreflightReport; node: string | null; ollamaApp: string | null }> {
  const isExec = d.isExec ?? isExecutable;
  const m = d.manifest ?? MANIFEST;
  const arch: Arch = d.arch ?? "arm64";
  const env = d.env ?? {};
  const find = (name: string, more: string[] = []): string | null => findOnPath(name, d.PATH, isExec) ?? more.find((p) => isExec(p)) ?? null;
  const found: Partial<Record<SetupCheckId, Found>> = {};
  const models = ollamaModels(d.totalmem);

  // Node: the first on the PATH, unless it is older than the floor and the wizard's own is new enough.
  const nodes = [findOnPath("node", d.PATH, isExec), path.join(privateNodeBinDir(d.home), "node")]
    .filter((p, i, a): p is string => !!p && isExec(p) && a.indexOf(p) === i);
  const nodeV = await Promise.all(nodes.map((p) => d.run(p, ["--version"], 5000)));
  const nodeAt = nodes.findIndex((_, i) => nodeV[i].code === 0 && !!versionIn(nodeV[i].out) && meetsFloor(versionIn(nodeV[i].out), m.tools.node.floor));
  const node = nodeAt >= 0 ? nodes[nodeAt] : null;
  found.node = node ? { ok: true, detail: `${firstLine(nodeV[nodeAt].out)} · ${node}` }
    : nodes.length ? { ok: false, detail: `${firstLine(nodeV[0].out) || "no version"} at ${nodes[0]}: ${BRAND.name} needs ${m.tools.node.floor} or newer` }
    : { ok: false, detail: "not found" };

  const claude = find("claude", [path.join(d.home, ".local", "bin", "claude")]);
  const codex = find("codex", [path.join(d.home, ".local", "bin", "codex")]);
  // Every uv a Mac may have, the PATH's first (inspection F5): the first that answers with a version at the floor is used.
  const uvs = [findOnPath("uv", d.PATH, isExec), path.join(d.home, ".local", "bin", "uv"), path.join(d.home, ".cargo", "bin", "uv")]
    .filter((p, i, a): p is string => !!p && isExec(p) && a.indexOf(p) === i);
  const ollamaCli = find("ollama");
  const ollamaApp = ollamaApps(d.home).find((p) => d.exists(p)) ?? null;
  const ollama = ollamaCli ?? ollamaApp;
  // Asked over HTTP, as provider.js asks: `ollama list` would open Ollama.app, and a check starts nothing.
  const curl = ollama ? find("curl") : null;

  const [uvV, claudeV, claudeAuth, codexV, codexAuth, ollamaV, tags] = await Promise.all([
    Promise.all(uvs.map((p) => d.run(p, ["--version"], 5000))),
    claude ? d.run(claude, ["--version"], 10_000) : null,
    claude ? d.run(claude, ["auth", "status", "--json"], 10_000) : null,
    codex ? d.run(codex, ["--version"], 10_000) : null,
    codex ? d.run(codex, ["login", "status"], 10_000) : null,
    // A CLI answers --version; the app alone is read from its Info.plist, so nothing opens it.
    ollamaCli ? d.run(ollamaCli, ["--version"], 5000)
      : ollamaApp ? d.run("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", path.join(ollamaApp, "Contents", "Info.plist")], 5000) : null,
    curl ? d.run(curl, [...OLLAMA_CURL, "-m", "3", `${OLLAMA_URL}/api/tags`], 5000) : null,
  ]);

  const uvVersions = uvV.map((r) => (r.code === 0 ? versionIn(r.out) : null));
  const uvAt = uvs.findIndex((_, i) => meetsFloor(uvVersions[i], m.tools.uv.floor));
  found.uv = uvAt >= 0 ? { ok: true, detail: `uv ${uvVersions[uvAt]} · ${uvs[uvAt]}` }
    : !uvs.length ? { ok: false, detail: "not installed" }
    : { ok: false, detail: uvVersions[0] ? `uv ${uvVersions[0]} at ${uvs[0]} is older than ${m.tools.uv.floor}` : `${uvs[0]} did not answer uv --version with a version` };

  found.claude = claude ? { ok: true, detail: `${firstLine(claudeV?.out ?? "") || "installed"} · ${claude}` } : { ok: false, detail: "not installed" };
  let claudeIn = false;
  try { claudeIn = !!(JSON.parse(claudeAuth?.out ?? "") as { loggedIn?: boolean }).loggedIn; } catch { /* not JSON: not logged in */ }
  found["claude-login"] = !claude ? { ok: false, detail: "install Claude Code first" } : claudeIn ? { ok: true, detail: "logged in" } : { ok: false, detail: "not logged in" };

  found.codex = codex ? { ok: true, detail: `${firstLine(codexV?.out ?? "") || "installed"} · ${codex}` } : { ok: false, detail: "not installed" };
  // `aos init`'s rule (cli/codex-host.js codexLoggedIn): exit 0 and "logged in", not "not logged in".
  const codexIn = !!codexAuth && codexAuth.code === 0 && /logged in/i.test(codexAuth.out) && !/not logged in/i.test(codexAuth.out);
  found["codex-login"] = !codex ? { ok: false, detail: "install the Codex CLI first" } : codexIn ? { ok: true, detail: "logged in" } : { ok: false, detail: "not logged in" };

  const pin = m.tools.ollama;
  const ollamaVersion = ollamaV?.code === 0 ? versionIn(ollamaV.out) : null;
  const oldMac = !!pin.minMacOS && !macOSAtLeast(d.macOS ?? "", pin.minMacOS);
  found.ollama = !ollama
    ? { ok: false, warn: true, detail: "not installed: background work waits for it", ...(oldMac ? { blocked: `needs macOS ${pin.minMacOS} or newer` } : {}) }
    : meetsFloor(ollamaVersion, pin.floor) ? { ok: true, detail: `${ollamaVersion} · ${ollama}` }
    // No version to read (inspection F5): not trusted; its download installs the app, or opens the one that is there.
    : !ollamaVersion ? { ok: false, warn: true, detail: `${ollama} did not report its version`, ...(oldMac ? { blocked: `needs macOS ${pin.minMacOS} or newer` } : {}) }
    // Ollama updates itself (its menu); the wizard never replaces an Ollama it did not put there.
    : { ok: false, warn: true, noFix: true, detail: `${ollamaVersion} at ${ollama} is older than ${pin.floor}, which ${models[0]} needs: update Ollama from its menu` };
  const have = parseTags(tags);
  const lacking = models.filter((x) => !have?.includes(x));
  found["ollama-models"] = !ollama ? { ok: false, warn: true, detail: "install Ollama first (then download them)" }
    : !have ? { ok: false, warn: true, detail: "Ollama is not running, so they could not be checked" }
    : lacking.length ? { ok: false, warn: true, detail: `not downloaded: ${lacking.join(", ")}` }
    : { ok: true, detail: models.join(" · ") };

  const hosts = { claude: !!found.claude?.ok && !!found["claude-login"]?.ok, codex: !!found.codex?.ok && !!found["codex-login"]?.ok };
  const okIds = new Set((Object.keys(found) as SetupCheckId[]).filter((id) => found[id]?.ok));
  const checks: SetupCheck[] = ORDER.map((id) => {
    const f: Found = found[id] ?? { ok: false, detail: "not checked" };
    const fixId = f.ok || f.noFix ? null : id;
    const fix = fixId ? FIXES[fixId] : null;
    return {
      id, label: LABELS[id], state: f.ok ? "ok" : f.warn ? "warn" : "missing", detail: f.detail, required: REQUIRED.includes(id),
      fix: fixId, fixKind: fix?.kind ?? null, fixLabel: fix?.label ?? null,
      fixCommand: !fix ? null : fix.kind === "terminal" ? fix.command : describeJob(fix.job, m, arch, d.home, env, d.totalmem),
      fixBlocked: fixId ? f.blocked ?? fixBlocked(fixId, okIds) : null,
    };
  });
  const ready = REQUIRED.every((id) => okIds.has(id));
  return { report: { checks, hosts, ready, models }, node, ollamaApp };
}
