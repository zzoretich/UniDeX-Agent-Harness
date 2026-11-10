// code:* — the Code chat view's transcript mirror (services/code-mirror.ts checks everything, and answers a refusal while the
// Code chat surface is off; the page names a terminal, a host and a session id), and code:git, its Diff pane's read-only
// git (services/code-git.ts: the page names a terminal, main picks the folder; no write surface gates it).

import { CH } from "../../shared/ipc";
import type { CodeGitService } from "../services/code-git";
import type { CodeMirrorService } from "../services/code-mirror";
import { CodeFollowArgs, CodeGitArgs, CodeUnfollowArgs, CodeViewArgs } from "./schemas";
import { onInvoke, onSend, type Trust } from "./trust";

export function registerCodeIpc(trust: Trust, code: CodeMirrorService, git: CodeGitService): void {
  onInvoke(CH.codeFollow, trust, CodeFollowArgs, async (req) => code.follow({ pty: req.pty, host: req.host, terminal: req.terminal, id: req.id ?? null }));
  onSend(CH.codeUnfollow, trust, CodeUnfollowArgs, ({ pty }) => code.unfollow(pty));
  onInvoke(CH.codeView, trust, CodeViewArgs, (req) => code.view(req));
  onInvoke(CH.codeGit, trust, CodeGitArgs, (req) => git.run(req.file === undefined ? { pty: req.pty, op: req.op } : { pty: req.pty, op: req.op, file: req.file }));
}
