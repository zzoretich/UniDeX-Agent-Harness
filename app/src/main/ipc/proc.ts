// proc:* and pty:* — the page's child processes and terminals (services/proc.ts and services/pty.ts do the checking).

import { CH } from "../../shared/ipc";
import type { ProcService } from "../services/proc";
import type { PtyService } from "../services/pty";
import { ExecRequestSchema, KillArgs, NoArgs, PtyAgentFlagsArgs, PtyAgentRequestSchema, PtyResizeArgs, PtySpawnRequestSchema, PtyWriteArgs, SpawnRequestSchema } from "./schemas";
import { onInvoke, onSend, onSync, type Trust } from "./trust";

export function registerProcIpc(trust: Trust, proc: ProcService, pty: PtyService): void {
  onSync(CH.procSpawn, trust, SpawnRequestSchema, (req) => {
    const r = proc.spawn(req);
    if (!r.ok && r.code === "EROFS") console.warn(`[main] refused spawn ${req.cmd} (${r.error})`);
    return r;
  });
  onSend(CH.procKill, trust, KillArgs, ({ id, signal }) => proc.kill(id, signal));
  onSync(CH.procExecSync, trust, ExecRequestSchema, (req) => proc.execSync(req));

  onSync(CH.ptyAvailable, trust, NoArgs, () => pty.available());
  onSync(CH.ptySpawn, trust, PtySpawnRequestSchema, (req) => {
    const r = pty.spawn(req);
    if (!r.ok && r.code === "EROFS") console.warn(`[main] refused terminal ${req.file} (${r.error})`);
    return r;
  });
  // A Code launch's agent as the terminal's own process (agent-computer D18); a fallback is the page's to handle.
  onInvoke(CH.ptySpawnAgent, trust, PtyAgentRequestSchema, async (req) => {
    const r = await pty.spawnAgent(req);
    if (!r.ok && r.code === "EROFS") console.warn(`[main] refused agent terminal ${req.host} (${r.error})`);
    return r;
  });
  // What main adds to that launch's line (agent-computer R70: Codex's --no-daemon), so the page shows the argv that runs.
  onInvoke(CH.ptyAgentFlags, trust, PtyAgentFlagsArgs, ({ host, sub }) => pty.agentFlags(host, sub));
  onSend(CH.ptyWrite, trust, PtyWriteArgs, ({ id, data }) => pty.write(id, data));
  onSend(CH.ptyResize, trust, PtyResizeArgs, ({ id, cols, rows }) => pty.resize(id, cols, rows));
  onSend(CH.ptyKill, trust, KillArgs, ({ id, signal }) => pty.kill(id, signal));
}
