// The compat Vault's events from main's watcher: each reported path becomes create, modify or delete in Obsidian's shape.
// The bridge is a stand-in over a temp folder (stat and the startup walk), and the feed is driven by hand, so a test
// can report exactly the paths a watcher would, including the bare folder a busy FSEvents queue leaves behind.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AosBridge, Result, StatInfo, WalkEntry } from "../../src/shared/ipc";
import { setBridge } from "../../obsidian-compat/src/bridge";
import { Vault } from "../../obsidian-compat/src/vault";

function fakeBridge(root: string): AosBridge {
  const stat = (abs: string): Result<StatInfo> => {
    try {
      const s = fs.statSync(abs);
      return { ok: true, data: { size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, file: s.isFile(), dir: s.isDirectory(), link: false, nlink: s.nlink } };
    } catch { return { ok: false, error: "ENOENT", code: "ENOENT" }; }
  };
  const walk = (): Result<WalkEntry[]> => {
    const out: WalkEntry[] = [];
    const go = (rel: string) => {
      for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) go(r);
        else { const s = fs.statSync(path.join(root, r)); out.push({ rel: r, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs }); }
      }
    };
    go("");
    return { ok: true, data: out };
  };
  return { fs: { stat, walk } } as unknown as AosBridge;
}

/** A Vault over a fresh temp folder, the events it emits, and `report` standing in for main's watcher. */
function watched(seed: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-compat-vault-"));
  for (const [rel, text] of Object.entries(seed)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  setBridge(fakeBridge(root));
  const vault = new Vault(root);
  const events: string[] = [];
  for (const name of ["create", "modify", "delete"]) vault.on(name, (f: { path: string }) => events.push(`${name} ${f.path}`));
  let onPaths: ((paths: string[]) => void) | null = null;
  vault.startWatching((cb) => { onPaths = cb; return () => { onPaths = null; }; });
  const report = (...paths: string[]) => { events.length = 0; onPaths!(paths); return [...events].sort(); };
  return { root, vault, report, done: () => { setBridge(null); fs.rmSync(root, { recursive: true, force: true }); } };
}

test("a file the watcher reports gone is a delete; a file it reports back is a create, then a modify", () => {
  const v = watched({ "TODO.md": "- [ ] a\n" });
  try {
    fs.rmSync(path.join(v.root, "TODO.md"));
    assert.deepEqual(v.report("TODO.md"), ["delete TODO.md"]);
    assert.deepEqual(v.report("TODO.md"), [], "a path it never knew is not deleted twice");
    fs.writeFileSync(path.join(v.root, "TODO.md"), "- [ ] b\n");
    assert.deepEqual(v.report("TODO.md"), ["create TODO.md"]);
    assert.deepEqual(v.report("TODO.md"), ["modify TODO.md"]);
  } finally { v.done(); }
});

test("a folder removed whole, reported only as the folder, deletes every file the vault knew under it", () => {
  // A busy FSEvents queue can coalesce `rm -rf running/` into the folder's path alone: the files under it must still
  // leave, or a tab that waits on their delete (the Agent Workspace's NOW) shows a run that has ended.
  const v = watched({
    "persona/teams/example/running/example-a-builder.json": "{}",
    "persona/teams/example/running2/keep.json": "{}",
    "persona/teams/example/TEAM.md": "# Example\n",
  });
  try {
    fs.mkdirSync(path.join(v.root, "persona/teams/example/running/sub"));
    fs.writeFileSync(path.join(v.root, "persona/teams/example/running/sub/b.json"), "{}");
    assert.deepEqual(v.report("persona/teams/example/running/sub/b.json"), ["create persona/teams/example/running/sub/b.json"]);
    fs.rmSync(path.join(v.root, "persona/teams/example/running"), { recursive: true, force: true });
    assert.deepEqual(v.report("persona/teams/example/running"), [
      "delete persona/teams/example/running/example-a-builder.json",
      "delete persona/teams/example/running/sub/b.json",
    ]);
    // Its neighbours stay known: a later delete of one is still reported once.
    assert.deepEqual(v.report("persona/teams/example/running"), [], "nothing is left to delete");
    fs.rmSync(path.join(v.root, "persona/teams/example/running2/keep.json"));
    assert.deepEqual(v.report("persona/teams/example/running2/keep.json"), ["delete persona/teams/example/running2/keep.json"]);
    assert.ok(v.vault.getFiles().some((f) => f.path === "persona/teams/example/TEAM.md"));
  } finally { v.done(); }
});
