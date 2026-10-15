// The wizard's rules for the host choice and for the command Finish tells the user to type (inspection rounds 2 and 3).

import { test } from "node:test";
import assert from "node:assert/strict";
import { addHostCommand, defaultHost, hostOffered, reconcileHost } from "../../src/renderer/setup/choices";

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

test("Finish's add-a-host command is aos hosts add, with no path in it to quote (M4)", () => {
  assert.equal(addHostCommand("~/.local/bin/aos"), "~/.local/bin/aos hosts add claude");
  assert.equal(addHostCommand("aos", "codex"), "aos hosts add codex");
});
