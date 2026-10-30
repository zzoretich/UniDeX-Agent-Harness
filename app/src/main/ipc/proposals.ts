// Human proposal decisions from the trusted main window. The renderer can choose a verb and the
// reviewed digest; the deterministic vault runtime validates paths, hashes, recipe and transaction.
import { randomBytes } from "node:crypto";
import { CH, type ProposalPreview, type ProposalUndo, type Result } from "../../shared/ipc";
import { onInvoke, type Trust } from "./trust";
import { NoArgs, ProposalNameArgs, ProposalDecisionArgs, ProposalUndoArgs } from "./schemas";

type Runtime = {
  read(root: string, name: string): { digest: string; slug: string; fields: Record<string, string> };
  preview(root: string, name: string): ProposalPreview;
  apply(root: string, name: string, digest: string, opts: { undoRoot: string }): unknown;
  reject(root: string, name: string, digest: string, opts: { undoRoot: string }): unknown;
  undo(root: string, undoId: string, opts: { undoRoot: string }): unknown;
  recentUndos(root: string, opts: { undoRoot: string }): ProposalUndo[];
};
// This literal import is bundled into Electron's main process at build time. Loading the
// applier from the writable vault would let a changed vault script redefine approval.
const trustedRuntime = require("../../../../brain/scripts/persona/proposal.js") as Runtime;
function runtime(_root: string): Runtime { return trustedRuntime; }
function answer<T>(root: string | null, fn: (p: Runtime, r: string) => T): Result<T> {
  if (!root) return { ok: false, error: "No vault is attached", code: "ENOENT" };
  try { return { ok: true, data: fn(runtime(root), root) }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e), code: "EINVAL" }; }
}
export function registerProposalsIpc(trust: Trust, vaultRoot: () => string | null, undoRoot: () => string, enabled: () => boolean): void {
  const reviewed = new Map<string, { name: string; digest: string; at: number }>();
  const issue = (name: string, digest: string): string => {
    for (const [key, value] of reviewed) if (Date.now() - value.at > 300_000) reviewed.delete(key);
    const token = randomBytes(16).toString("hex");
    reviewed.set(token, { name, digest, at: Date.now() });
    return token;
  };
  const consume = (name: string, digest: string, token: string): void => {
    const value = reviewed.get(token);
    reviewed.delete(token);
    if (!value || value.name !== name || value.digest !== digest || Date.now() - value.at > 300_000) throw new Error("Review expired; open the proposal again");
  };
  onInvoke(CH.proposalPreview, trust, ProposalNameArgs, async ({ name }) => answer(vaultRoot(), (p, root) => {
    try { const preview = p.preview(root, name); return { ...preview, token: issue(name, preview.digest) }; }
    catch (e) {
      if (!(e instanceof Error) || !e.message.includes("legacy proposal needs an exact diff")) throw e;
      const old = p.read(root, name);
      return { name, slug: old.slug, digest: old.digest, token: issue(name, old.digest), recheck: old.fields.recheck || null, changes: [], legacy: true };
    }
  }));
  onInvoke(CH.proposalApply, trust, ProposalDecisionArgs, async ({ name, digest, token }) => answer(vaultRoot(), (p, root) => { if (!enabled()) throw new Error("Instruction proposals are off in this app"); consume(name, digest, token); return p.apply(root, name, digest, { undoRoot: undoRoot() }); }));
  onInvoke(CH.proposalReject, trust, ProposalDecisionArgs, async ({ name, digest, token }) => answer(vaultRoot(), (p, root) => { if (!enabled()) throw new Error("Instruction proposals are off in this app"); consume(name, digest, token); return p.reject(root, name, digest, { undoRoot: undoRoot() }); }));
  onInvoke(CH.proposalUndos, trust, NoArgs, async () => answer(vaultRoot(), (p, root) => p.recentUndos(root, { undoRoot: undoRoot() })));
  onInvoke(CH.proposalUndo, trust, ProposalUndoArgs, async ({ undoId }) => answer(vaultRoot(), (p, root) => { if (!enabled()) throw new Error("Instruction proposals are off in this app"); return p.undo(root, undoId, { undoRoot: undoRoot() }); }));
}
