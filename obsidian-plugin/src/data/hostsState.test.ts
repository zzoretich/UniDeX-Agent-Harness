import { test } from "node:test";
import assert from "node:assert/strict";
import { addHostText, cachedHostsStatus, hostView, nextSteps, parseHostsStatus } from "./hostsState";

const S = (o: Partial<{ enabled: boolean; installed: boolean | null; bin: string | null; signedIn: boolean | null }>) => ({ enabled: false, installed: true, bin: "/opt/bin/codex", signedIn: true, ...o });

test("parseHostsStatus: `aos hosts status --json`, both hosts; anything else is not that", () => {
  const j = { schema: 1, vault: "/v", hosts: { claude: { enabled: true, installed: true, bin: "/opt/bin/claude", signedIn: true }, codex: { enabled: false, installed: false, bin: null, signedIn: null } } };
  assert.deepEqual(parseHostsStatus(j), { source: "runtime", hosts: { claude: { enabled: true, installed: true, bin: "/opt/bin/claude", signedIn: true }, codex: { enabled: false, installed: false, bin: null, signedIn: null } } });
  for (const bad of [null, {}, { hosts: { claude: {} } }, "x"]) assert.equal(parseHostsStatus(bad), null, JSON.stringify(bad));
});

test("the caches stand in until the runtime answers: on from agenticos.json, the CLI and the login from provider-state", () => {
  const c = cachedHostsStatus({ hosts: { claude: { enabled: true }, codex: { enabled: false, bin: "/opt/bin/codex" } } }, { checkedAt: "", name: "none", reason: "", claude: { loggedIn: false, checkedAt: "", bin: "/opt/bin/claude" } });
  assert.equal(c.source, "cache");
  assert.deepEqual(c.hosts.claude, { enabled: true, installed: true, bin: "/opt/bin/claude", signedIn: false });
  assert.deepEqual(c.hosts.codex, { enabled: false, installed: true, bin: "/opt/bin/codex", signedIn: null });
  assert.deepEqual(cachedHostsStatus({}, null).hosts.claude, { enabled: true, installed: null, bin: null, signedIn: null }, "a config from before hosts is Claude Code");
  assert.deepEqual(cachedHostsStatus(null, null).hosts.codex, { enabled: false, installed: null, bin: null, signedIn: null });
});

test("hostView: ready, signed out, missing; off with Add only when installed and signed in, else why and what to do", () => {
  const ready = hostView("codex", S({ enabled: true }));
  assert.deepEqual([ready.state, ready.text, ready.add.shown, ready.signIn, ready.install], ["ready", "On · signed in · /opt/bin/codex", false, null, null]);
  const out = hostView("claude", S({ enabled: true, bin: "/opt/bin/claude", signedIn: false }));
  assert.deepEqual([out.state, out.signIn], ["signed-out", "claude auth login"]);
  const missing = hostView("codex", S({ enabled: true, installed: false, bin: null, signedIn: null }));
  assert.equal(missing.state, "missing");
  assert.deepEqual(missing.install, ["Open Terminal (in Applications ▸ Utilities).", "Type curl -fsSL https://chatgpt.com/codex/install.sh | sh and press Return.", "Type codex login and press Return to sign in.", "Then ⟳ Check again here."]);
  const off = hostView("codex", S({}));
  assert.deepEqual([off.state, off.add], ["off", { shown: true, enabled: true, why: null }]);
  const offOut = hostView("codex", S({ signedIn: false }));
  assert.deepEqual([offOut.state, offOut.add, offOut.signIn], ["off-signed-out", { shown: true, enabled: false, why: "Sign in to Codex first (codex login)" }, "codex login"]);
  const offMissing = hostView("claude", S({ installed: false, bin: null, signedIn: null }));
  assert.deepEqual([offMissing.state, offMissing.add.enabled, offMissing.add.why], ["off-missing", false, "Install Claude Code and sign in first"]);
  assert.equal(offMissing.install![1], "Type curl -fsSL https://claude.ai/install.sh | bash and press Return.");
  assert.equal(offMissing.install![3], "Then ⟳ Check again here, and Add Claude Code.");
  const unknown = hostView("codex", S({ installed: null, bin: null, signedIn: null }));
  assert.deepEqual([unknown.state, unknown.add.enabled, unknown.text], ["unknown", false, "Not added to this vault · not checked yet"]);
  // A sign-in check that hung (aos hosts status stops it after 10 s): not known, never "signed out".
  const hung = parseHostsStatus({ hosts: { claude: { enabled: true, installed: true, bin: "/opt/bin/claude", signedIn: null, probe: "timed out" }, codex: { enabled: false, installed: true, bin: "/opt/bin/codex", signedIn: null, probe: "timed out" } } })!;
  assert.equal(hung.hosts.claude.timedOut, true);
  assert.equal(hostView("claude", hung.hosts.claude).text, "On · /opt/bin/claude · its sign-in check did not answer in time; ⟳ Check again");
  const hungOff = hostView("codex", hung.hosts.codex);
  assert.deepEqual([hungOff.state, hungOff.add.enabled, hungOff.add.why], ["unknown", false, "Its sign-in check did not answer: ⟳ Check again"]);
});

test("what Add does is said first; the steps hosts add prints after it are read back", () => {
  assert.match(addHostText("codex"), /^This turns Codex on for this vault \(the other host stays as it is\), installs the Codex plugin .* It runs aos hosts add codex\./);
  assert.doesNotMatch(addHostText("codex"), /Chief of Staff/);
  // The first host also sets up the Chief of Staff, which waited for one (install-import B2).
  assert.match(addHostText("claude", true), /schedules\. As your first host, it also sets up your Chief of Staff, which waited for one: with the default answers and its daily duties scheduled, unless you already have one \(aos persona changes them\)\. It runs aos hosts add claude\./);
  const stdout = "hosts add codex: /opt/bin/codex\n- import from Codex: …\n\nNext steps:\n  1. Open `codex`, run /hooks, and trust the agenticos@agenticos-workbench entries once.\n  2. Bring in its session history: aos import --from codex\n";
  assert.deepEqual(nextSteps(stdout), ["Open `codex`, run /hooks, and trust the agenticos@agenticos-workbench entries once.", "Bring in its session history: aos import --from codex"]);
  const claude = "Next steps:\n  1. Add this line to your CLAUDE.md (/c/CLAUDE.md) if it is not there yet:\n       @/v/AGENTICOS.md\n  2. Bring in its session history: aos import --from claude\n";
  assert.deepEqual(nextSteps(claude), ["Add this line to your CLAUDE.md (/c/CLAUDE.md) if it is not there yet: @/v/AGENTICOS.md", "Bring in its session history: aos import --from claude"]);
  assert.deepEqual(nextSteps("done"), []);
});
