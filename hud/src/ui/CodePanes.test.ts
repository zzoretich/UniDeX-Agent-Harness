// The Code top bar's ⎇ branch, `+n −n` and Files place (spec 2026-11-09-code-chat C8): what CodePanes draws from a status
// main read, and when it reads one (ruling R55). "obsidian" resolves to a stub under node:test, the panes' elements to a
// stand-in that takes every call, and code:git to a fake that answers when the test says.
import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { setHudHost, type HostCode, type HostGitDiff, type HostGitStatus, type HostResult } from "../host";
import { createNodeHost } from "../nodeHost";
import type { TerminalSession } from "../data/terminalSession";
import type { Place } from "../data/terminalLaunch";
import type * as Panes from "./CodePanes";

const STUB = "obsidian-stub-code-panes";
const M = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string };
const resolve = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "obsidian" ? STUB : resolve.call(this, request, ...rest);
};
require.cache[STUB] = { id: STUB, filename: STUB, loaded: true, exports: { setIcon: () => {} } } as unknown as NodeJS.Module;
const { CodePanes, branchText, filesFolder, totalsText } = require("./CodePanes") as typeof Panes;

const st = (o: Partial<HostGitStatus>): HostGitStatus => ({ repo: true, branch: "main", detached: false, merging: false, files: [], ...o });
const f = (path: string, added: number | null, removed: number | null) => ({ path, status: ".M", added, removed });

test("the branch: ⎇ and its name, detached when HEAD is; nothing where main found no repository", () => {
  assert.equal(branchText(st({})), "⎇ main");
  assert.equal(branchText(st({ branch: null, detached: true })), "⎇ detached");
  assert.equal(branchText(st({ repo: false, branch: null })), null);
  assert.equal(branchText(null), null);
});

test("+n −n across the changed files, a binary file adding nothing; nothing for a clean tree or no repository", () => {
  assert.equal(totalsText(st({ files: [f("a.ts", 3, 1), f("b.md", 2, 0), f("c.png", null, null)] })), "+5 −1");
  assert.equal(totalsText(st({ files: [] })), "");
  assert.equal(totalsText(st({ repo: false })), "");
  assert.equal(totalsText(null), "");
});

test("Files opens a vault workspace's folder (Scratch and a linked one too), never the vault, home or another folder", () => {
  assert.equal(filesFolder({ kind: "workspace", label: "tide", dir: "/work/demo/vault/workspaces/tide", workspace: "tide" }), "workspaces/tide");
  assert.equal(filesFolder({ kind: "workspace", label: "tide", dir: "/work/demo/code", workspace: "tide", linked: true }), "workspaces/tide");
  assert.equal(filesFolder({ kind: "scratch", label: "Scratch", dir: "/work/demo/vault/workspaces/scratch", workspace: "scratch" }), "workspaces/scratch");
  for (const kind of ["vault", "home", "other"] as const) assert.equal(filesFolder({ kind, label: kind, dir: "/work/demo" }), null);
  assert.equal(filesFolder(null), null);
});

// ── when the status is read (ruling R55) ──

/** An element that takes every call the panes make and answers with another. */
const el = (): HTMLElement => new Proxy({}, { get: (_t, k) => (k === "childElementCount" ? 0 : () => el()) }) as HTMLElement;
const flush = () => new Promise<void>((r) => setImmediate(r));

/** code:git standing in for main: each call waits until the test answers it (a status by default, or `r`). */
function fakeGit() {
  const calls: Array<{ req: { pty: string; op: string }; answer: (r?: HostResult<HostGitStatus | HostGitDiff>) => void }> = [];
  const git = (req: { pty: string; op: "status" | "diff"; file?: string }) =>
    new Promise<HostResult<HostGitStatus | HostGitDiff>>((resolve) => calls.push({ req, answer: (r) => resolve(r ?? { ok: true, data: st({}) }) }));
  setHudHost({ ...createNodeHost(), code: { git } as unknown as HostCode });
  return calls;
}

/** A terminal whose output the test prints; `ptyId` changes when another process takes it over. */
function terminal(id: string, pty: string) {
  const listeners = new Set<() => void>();
  const s = { id, ptyId: pty, onData: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; } } as unknown as TerminalSession;
  return { s, listeners, print: () => { for (const l of [...listeners]) l(); } };
}

function panesFor(active: () => TerminalSession | undefined, place: () => Place = () => ({ kind: "other", label: "", dir: "/work/demo" })) {
  const panes = new CodePanes({ activeSession: active, placeOf: place, computer: () => null, changed: () => {} });
  panes.mount(el());
  return panes;
}

test("one status read at a time: refreshes asked for while one runs read once more after it, not once each (R55)", async () => {
  const calls = fakeGit();
  const t = terminal("t1", "p1");
  const panes = panesFor(() => t.s);
  const first = panes.refresh();
  void panes.refresh();
  void panes.refresh();
  void panes.refresh();
  assert.equal(calls.length, 1, "nothing more starts while a read runs");
  calls[0].answer();
  await first;
  await flush();
  assert.equal(calls.length, 2, "one read after it");
  calls[1].answer();
  await flush();
  assert.equal(calls.length, 2, "and no more");
  panes.destroy();
});

test("behind another rail tab nothing is read: not on output, a draw or Refresh; shown again, one read, and output reads again (R55)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = fakeGit();
  const term = terminal("t1", "p1");
  const panes = panesFor(() => term.s);
  panes.follow(term.s);
  assert.equal(calls.length, 1, "a terminal followed is read once");
  calls[0].answer();
  await flush();
  term.print();
  t.mock.timers.tick(1500);
  assert.equal(calls.length, 2, "its output, settled, reads it again");
  calls[1].answer();
  await flush();
  // The Code tab is left with output waiting to settle.
  term.print();
  panes.hide();
  assert.equal(term.listeners.size, 0, "its output is no longer followed");
  t.mock.timers.tick(10_000);
  term.print();
  panes.follow(term.s);
  void panes.refresh();
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(calls.length, 2, "nothing is read while hidden");
  assert.equal(term.listeners.size, 0, "a draw while hidden follows nothing");
  panes.show();
  assert.equal(calls.length, 3, "shown again: one read");
  calls[2].answer();
  await flush();
  panes.show();
  assert.equal(calls.length, 3, "shown while shown reads nothing");
  term.print();
  t.mock.timers.tick(1500);
  assert.equal(calls.length, 4, "its output reads it again");
  calls[3].answer();
  await flush();
  panes.destroy();
});

test("a terminal main refused is not read again on its output or a selection; a forced read, a new process or a new place asks again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const calls = fakeGit();
  const term = terminal("t1", "p1");
  let place: Place = { kind: "vault", label: "Vault", dir: "/work/demo/vault" };
  const panes = panesFor(() => term.s, () => place);
  const refusal = { ok: false as const, error: "the vault, outside its workspaces", code: "EROFS" };
  panes.follow(term.s);
  assert.equal(calls.length, 1, "selected: one read");
  calls[0].answer(refusal);
  await flush();
  term.print();
  t.mock.timers.tick(10_000);
  term.print();
  t.mock.timers.tick(10_000);
  assert.equal(calls.length, 1, "its output reads nothing: the answer can't change for this process in this place");
  // Selected again, long after: still nothing.
  panes.follow(undefined);
  panes.follow(term.s);
  assert.equal(calls.length, 1, "a selection reads nothing");
  // The Code tab shown again (a forced read) asks once more.
  panes.hide();
  panes.show();
  assert.equal(calls.length, 2, "a forced read asks again");
  calls[1].answer(refusal);
  await flush();
  // A code folder linked since makes the same process a workspace's: its output reads again.
  place = { kind: "workspace", label: "tide", dir: "/work/demo/code", workspace: "tide", linked: true };
  term.print();
  t.mock.timers.tick(1500);
  assert.equal(calls.length, 3, "a new place reads again");
  calls[2].answer(refusal);
  await flush();
  // Another process in the terminal (the login shell after the agent): read again.
  (term.s as unknown as { ptyId: string }).ptyId = "p2";
  panes.follow(term.s);
  assert.equal(calls.length, 4, "a new process reads again");
  calls[3].answer();
  await flush();
  term.print();
  t.mock.timers.tick(1500);
  assert.equal(calls.length, 5, "an answered terminal's output reads again");
  calls[4].answer();
  await flush();
  panes.destroy();
});
