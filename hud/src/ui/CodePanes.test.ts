// The Code top bar's ⎇ branch, `+n −n` and Files place (spec 2026-11-09-code-chat C8): what CodePanes draws from a status
// main read. "obsidian" resolves to a stub under node:test; these are the panes' pure parts.
import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import type { HostGitStatus } from "../host";
import type * as Panes from "./CodePanes";

const STUB = "obsidian-stub-code-panes";
const M = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string };
const resolve = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "obsidian" ? STUB : resolve.call(this, request, ...rest);
};
require.cache[STUB] = { id: STUB, filename: STUB, loaded: true, exports: { setIcon: () => {} } } as unknown as NodeJS.Module;
const { branchText, filesFolder, totalsText } = require("./CodePanes") as typeof Panes;

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
