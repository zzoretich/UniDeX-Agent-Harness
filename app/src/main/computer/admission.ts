// Admission to the computer bridge (agent-computer D18, refusal text D17): only the agenticos MCP server of an agent CLI
// (Claude Code or Codex) that this app spawned gets in. The peer must run the vault's MCP server script, its parent
// must be a registered CLI whose running code is vendor-signed or an npm install of the vendor package, and each CLI
// connects once. Everything fails closed: a lookup that returns null or throws is a refusal. argv is trusted only for
// the two documented checks (the peer's argv[1] and an npm CLI's argv[1]); the native parser can shift it otherwise.

import fs from "node:fs";
import path from "node:path";
import type { ProcInfo } from "./peer";
import type { AgentRef, AgentRegistry } from "./registry";
import { REFUSAL } from "./refusals";

export interface Sys {
  procInfo(pid: number): ProcInfo | null;
  /** Static check of the file at a path: slow, used before a launch. */
  teamId(path: string): string | null;
  /** Dynamic check of the running process's code: fast, used at admission. */
  processTeamId(pid: number): string | null;
  realpath(p: string): string;
  /** File identity for the launch cache; fs.statSync when absent. */
  stat?(p: string): { ino: number; size: number; mtimeMs: number; ctimeMs: number };
}

type Host = "claude" | "codex";
type Form = "native" | "npm";

export const VENDOR: Readonly<Record<Host, { team: string; pkg: string }>> = {
  claude: { team: "Q6L2SF6YDW", pkg: "@anthropic-ai/claude-code" },
  codex: { team: "2DC432GLL2", pkg: "@openai/codex" },
};

export type Admit = { ok: true; agent: AgentRef } | { ok: false; reason: string };

const NOT_STARTED = REFUSAL.notStarted;
const ALREADY_OPEN = REFUSAL.alreadyOpen;

function real(sys: Sys, p: string): string | null {
  try {
    return sys.realpath(p);
  } catch {
    return null;
  }
}

function inPackage(rp: string, host: Host): boolean {
  // The last node_modules segment must be the vendor's package: nothing nested inside it, nor a copy under another package.
  const i = rp.lastIndexOf("/node_modules/");
  return i >= 0 && rp.slice(i + "/node_modules/".length).startsWith(`${VENDOR[host].pkg}/`);
}

const launchCache = new WeakMap<Sys, Map<string, string | null>>();

/** Judges a binary before it is launched. The static signature check is slow, so its result is cached per file identity. */
export function launchForm(host: Host, bin: string, sys: Sys, trusted: readonly string[] = []): Form | null {
  const rp = real(sys, bin);
  if (rp === null) return null;
  if (trusted.includes(rp)) return "native";
  if (inPackage(rp, host)) return "npm";
  let team: string | null;
  try {
    const identity = (): string | null => {
      try {
        const st = (sys.stat ?? fs.statSync)(rp);
        return `${rp}|${st.ino}|${st.size}|${st.mtimeMs}|${st.ctimeMs}`;
      } catch {
        return null;
      }
    };
    const key = identity();
    let cache = launchCache.get(sys);
    if (!cache) launchCache.set(sys, (cache = new Map()));
    if (key !== null && cache.has(key)) team = cache.get(key) ?? null;
    else {
      team = sys.teamId(rp);
      // Cache only when the file is the same after the slow check as before it.
      if (key !== null && identity() === key) cache.set(key, team);
    }
  } catch {
    return null;
  }
  return team !== null && team === VENDOR[host].team ? "native" : null;
}

/** Judges a running process: native when its code is signed by the vendor's team, npm when node runs the vendor package. */
export function installForm(host: Host, p: ProcInfo, sys: Sys, trusted: readonly string[] = []): Form | null {
  const rp = real(sys, p.path);
  if (rp === null) return null;
  if (trusted.includes(rp)) return "native";
  try {
    if (sys.processTeamId(p.pid) === VENDOR[host].team) return "native";
  } catch {
    return null;
  }
  if (path.basename(p.path) === "node" && typeof p.argv[1] === "string" && path.isAbsolute(p.argv[1])) {
    const script = real(sys, p.argv[1]);
    if (script !== null && inPackage(script, host)) return "npm";
  }
  return null;
}

function refuse(reason: string): Admit {
  return { ok: false, reason };
}

export function admit(peerPid: number, o: { reg: AgentRegistry; sys: Sys; server: string; trusted?: readonly string[] }): Admit {
  const { reg, sys, server } = o;
  const trusted = o.trusted ?? [];
  try {
    const peer = sys.procInfo(peerPid);
    if (!peer || typeof peer.argv[1] !== "string" || !path.isAbsolute(peer.argv[1]) || real(sys, peer.argv[1]) !== server) return refuse(NOT_STARTED);
    const parent = sys.procInfo(peer.ppid);
    if (!parent) return refuse(NOT_STARTED);

    let agent = reg.get(parent.pid);
    if (agent && installForm(agent.host, parent, sys, trusted) === null) agent = undefined;

    if (!agent) {
      // The npm Codex shim: node runs the package, which launches the signed native binary that launches the server.
      // M13: registration first; a signature is read only for a chain whose grandparent the app registered as Codex.
      const grand = sys.procInfo(parent.ppid);
      const g = grand ? reg.get(grand.pid) : undefined;
      if (grand && g && g.host === "codex") {
        const rp = real(sys, parent.path);
        const nativeChild = rp !== null && (trusted.includes(rp) || sys.processTeamId(parent.pid) === VENDOR.codex.team);
        if (nativeChild && installForm("codex", grand, sys, trusted) === "npm") agent = g;
      }
    }
    if (!agent) return refuse(NOT_STARTED);
    if (!reg.claim(agent.pid)) return refuse(ALREADY_OPEN);
    return { ok: true, agent };
  } catch {
    return refuse(NOT_STARTED);
  }
}
