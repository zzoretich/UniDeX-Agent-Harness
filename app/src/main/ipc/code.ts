// code:* — the Code chat view's transcript mirror (services/code-mirror.ts checks everything, and answers a refusal while the
// Code chat surface is off; the page names a terminal, a host and a session id).

import { CH } from "../../shared/ipc";
import type { CodeMirrorService } from "../services/code-mirror";
import { CodeFollowArgs, CodeUnfollowArgs, CodeViewArgs } from "./schemas";
import { onInvoke, onSend, type Trust } from "./trust";

export function registerCodeIpc(trust: Trust, code: CodeMirrorService): void {
  onInvoke(CH.codeFollow, trust, CodeFollowArgs, async (req) => code.follow({ pty: req.pty, host: req.host, terminal: req.terminal, id: req.id ?? null }));
  onSend(CH.codeUnfollow, trust, CodeUnfollowArgs, ({ pty }) => code.unfollow(pty));
  onInvoke(CH.codeView, trust, CodeViewArgs, (req) => code.view(req));
}
