// The wizard's rules for the host choice and for the command Finish tells the user to type (inspection round 2, M2, M4).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { absoluteVault, addHostCommand, defaultHost, hostOffered, reconcileHost, shellQuote } from "../../src/renderer/setup/choices";

const none = { claude: false, codex: false };
const claude = { claude: true, codex: false };
const both = { claude: true, codex: true };

test("F5: Choose offers a host when it is ready, both when both are, and No agent CLI yet always", () => {
  assert.deepEqual([hostOffered("none", none), hostOffered("none", claude), hostOffered("none", both), hostOffered("claude", claude), hostOffered("codex", claude), hostOffered("both", both)], [true, true, true, true, false, true]);
  assert.deepEqual([defaultHost(none), defaultHost(claude), defaultHost({ claude: false, codex: true }), defaultHost(both)], ["none", "claude", "codex", "both"]);
});

test("M2, F5: after a later check the wizard's own choice follows what is ready; the user's stands while it is offered", () => {
  assert.equal(reconcileHost("none", claude), "claude", "a host logged in since replaces the default none");
  assert.equal(reconcileHost("none", claude, true), "none", "an explicit No agent CLI yet is kept");
  assert.equal(reconcileHost("none", both, true), "none");
  assert.equal(reconcileHost("none", none), "none");
  assert.equal(reconcileHost("codex", both, true), "codex", "the user's choice stands while it is offered");
  assert.equal(reconcileHost("both", claude, true), "claude", "one host logged out: no longer offered");
  assert.equal(reconcileHost("claude", none, true), "none");
  assert.equal(reconcileHost(null, both), "both");
});

test("M4: the vault in Finish's command is absolute and quoted for the shell, embedded quotes included", () => {
  assert.equal(shellQuote("/srv/x/AgenticOS"), "/srv/x/AgenticOS");
  assert.equal(shellQuote("/Volumes/My Disk/Vault"), "'/Volumes/My Disk/Vault'");
  assert.equal(shellQuote("/tmp/it's; rm -rf ~"), "'/tmp/it'\\''s; rm -rf ~'");
  assert.equal(absoluteVault("~/My Vault", "/h"), "/h/My Vault");
  assert.equal(absoluteVault("~", "/h"), "/h");
  assert.equal(addHostCommand("~/.local/bin/aos", "~/My 'Vault'", "/h"), "~/.local/bin/aos init --vault '/h/My '\\''Vault'\\''' --host claude");
  // What a shell makes of it: exactly the one path, with nothing run.
  for (const vault of ["/tmp/My Vault", "/tmp/it's here", "/tmp/$(touch x)`y`", "/tmp/a\"b"]) {
    const r = spawnSync("/bin/sh", ["-c", `printf '%s' ${shellQuote(vault)}`], { encoding: "utf8" });
    assert.equal(r.stdout, vault);
  }
});
