// The wizard's rules for the host choice and for the command Finish tells the user to type (inspection round 2, M2, M4).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { absoluteVault, addHostCommand, defaultHost, hostOffered, reconcileHost, shellQuote } from "../../src/renderer/setup/choices";

const none = { claude: false, codex: false };
const claude = { claude: true, codex: false };
const both = { claude: true, codex: true };

test("M2: Choose offers a host when it is ready, both when both are, and none only when neither is", () => {
  assert.deepEqual([hostOffered("none", none), hostOffered("none", claude), hostOffered("claude", claude), hostOffered("codex", claude), hostOffered("both", both)], [true, false, true, false, true]);
  assert.deepEqual([defaultHost(none), defaultHost(claude), defaultHost({ claude: false, codex: true }), defaultHost(both)], ["none", "claude", "codex", "both"]);
});

test("M2: after a later check, a choice no longer offered becomes a ready host; one still offered is kept", () => {
  assert.equal(reconcileHost("none", claude), "claude", "a host logged in since: none is not offered any more");
  assert.equal(reconcileHost("none", none), "none");
  assert.equal(reconcileHost("codex", both), "codex", "the user's choice stands while it is offered");
  assert.equal(reconcileHost("both", claude), "claude", "one host logged out");
  assert.equal(reconcileHost("claude", none), "none");
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
