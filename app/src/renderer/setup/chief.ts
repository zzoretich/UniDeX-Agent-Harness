// The wizard's line on where the Chief of Staff runs (local-first A4). Pure, so tests/unit/setup.test.ts can check it.

import type { InstallRequest, PersonaAnswers } from "../../shared/ipc";
import { CHIEF_MODELS } from "../../shared/ipc";

/**
 * Where the Chief of Staff's duties run, in words: the hosted model on the primary host (Claude Code when it is chosen,
 * else Codex), the failover with both, and the hourly check on this Mac's local model.
 */
export function chiefSummary(host: InstallRequest["host"], p: Pick<PersonaAnswers, "dutyModel" | "dutyCodexModel">): string {
  const claude = `Claude Code · ${p.dutyModel.trim() || CHIEF_MODELS.claude}`;
  const codex = `Codex · ${p.dutyCodexModel.trim() || "your Codex default"}`;
  const runs = host === "codex" ? `Duties run on ${codex}` : host === "both" ? `Duties run on ${claude}, and on ${codex} when Claude Code can't start one` : `Duties run on ${claude}`;
  return `${runs}, a hosted model. The hourly check runs on this Mac's local model and wakes it only when something changed.`;
}
