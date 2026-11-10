// code:* — the Code chat view's transcript mirror (services/code-mirror.ts checks everything, and answers a refusal while the
// Code chat surface is off; the page names a terminal, a host and a session id), code:git, its Diff pane's read-only git
// (services/code-git.ts: the page names a terminal, main picks the folder; no write surface gates it), and code:save-image,
// its composer's images (services/code-images.ts: the page sends a type and base64, main checks them and picks the path,
// in the app's own data folder; refused while the Code chat surface is off).

import { CH } from "../../shared/ipc";
import type { CodeGitService } from "../services/code-git";
import type { CodeImageService } from "../services/code-images";
import type { CodeMirrorService } from "../services/code-mirror";
import { CodeFollowArgs, CodeGitArgs, CodeSaveImageArgs, CodeUnfollowArgs, CodeViewArgs } from "./schemas";
import { onInvoke, onSend, type Trust } from "./trust";

export function registerCodeIpc(trust: Trust, code: CodeMirrorService, git: CodeGitService, images: CodeImageService): void {
  onInvoke(CH.codeFollow, trust, CodeFollowArgs, async (req) => code.follow({ pty: req.pty, host: req.host, terminal: req.terminal, id: req.id ?? null }));
  onSend(CH.codeUnfollow, trust, CodeUnfollowArgs, ({ pty }) => code.unfollow(pty));
  onInvoke(CH.codeView, trust, CodeViewArgs, (req) => code.view(req));
  onInvoke(CH.codeGit, trust, CodeGitArgs, (req) => git.run(req.file === undefined ? { pty: req.pty, op: req.op } : { pty: req.pty, op: req.op, file: req.file }));
  onInvoke(CH.codeSaveImage, trust, CodeSaveImageArgs, async (req) => images.save({ mime: req.mime, data: req.data }));
}
