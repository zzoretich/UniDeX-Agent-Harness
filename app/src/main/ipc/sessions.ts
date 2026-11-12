// session:* and git:* — agent sessions in a workspace, and the workspace's repository (services/sessions.ts and
// services/git.ts check everything; the page names a workspace, a thread, a host, a prompt, a file or a message).

import { CH } from "../../shared/ipc";
import type { GitService } from "../services/git";
import type { SessionService } from "../services/sessions";
import { GitCommitArgs, GitDiffArgs, GitStatusArgs, NoArgs, SessionCatalogArgs, SessionRemoveSchema, SessionSendSchema, SessionStartSchema, ThreadArgs } from "./schemas";
import { onInvoke, onSend, type Trust } from "./trust";

export function registerSessionIpc(trust: Trust, sessions: SessionService, git: GitService): void {
  onInvoke(CH.sessionStart, trust, SessionStartSchema, (req) => sessions.start(req));
  onInvoke(CH.sessionSend, trust, SessionSendSchema, (req) => sessions.send(req));
  onSend(CH.sessionStop, trust, ThreadArgs, ({ thread }) => sessions.stop(thread));
  onInvoke(CH.sessionRemove, trust, SessionRemoveSchema, ({ thread }) => sessions.remove(thread));
  onInvoke(CH.sessionList, trust, NoArgs, () => sessions.list());
  onInvoke(CH.sessionRead, trust, ThreadArgs, ({ thread }) => sessions.read(thread));
  onInvoke(CH.sessionCatalog, trust, SessionCatalogArgs, ({ refresh }) => sessions.catalog(refresh === true));
  onInvoke(CH.gitStatus, trust, GitStatusArgs, ({ workspace }) => git.status(workspace));
  onInvoke(CH.gitDiff, trust, GitDiffArgs, ({ workspace, file }) => git.diff(workspace, file));
  onInvoke(CH.gitCommit, trust, GitCommitArgs, ({ workspace, message }) => git.commit(workspace, message));
}
