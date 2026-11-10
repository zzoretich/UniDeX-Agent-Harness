// TerminalLauncher's Spaces-on paths (spaces-redesign D28, D29): ⇧⌘N's createAndLaunch and More › Link code folder…'s
// linkRepo run `aos workspace new` and `aos workspace set` through the page's aosJson (the spaces surface), fall back to
// today's HostFs write only for a refused spawn or an old runtime, and never otherwise. A fake plugin records the argvs
// and the terminals; the vault is a temp folder (the Node host), and nothing is spawned.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TerminalLauncher } from "./terminalLauncher";
import { launchArgs } from "./terminalLaunch";
import { setHudHost, type HudHost } from "../host";
import { createNodeHost } from "../nodeHost";
import type { AosJsonResult } from "./aosRun";

type Answer = Partial<AosJsonResult<unknown>> & { error?: string };

function world(answers: Array<Answer | ((args: string[]) => Answer)>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-tl-test-"));
  const vault = path.join(root, "Vault");
  const cfg = path.join(root, "cfg");
  fs.mkdirSync(path.join(vault, "workspaces"), { recursive: true });
  fs.mkdirSync(cfg, { recursive: true });
  const calls: string[][] = [];
  const scans: string[] = [];
  const terminals: Array<{ cwd: string; host: string; typed: string[] }> = [];
  const agents: Array<{ spec: { host: string; configDir?: string | null }; place: { dir: string }; shell?: string }> = [];
  const launched: unknown[] = [];
  /** What a Code launch's attach answers (TerminalPool.createAgent): main's agent, a fallback's reason, or a refusal. */
  let attach: () => Promise<{ agent: boolean; reason: string | null }> = async () => ({ agent: true, reason: null });
  let closed = false;
  let n = 0;
  const plugin = {
    vaultRoot: () => vault,
    claudeConfigDir: () => cfg,
    settings: { terminalChoice: undefined, sessionChoice: undefined, terminalShell: "/bin/sh" },
    saveSettings: async () => {},
    runBrainScript: (rel: string) => { scans.push(rel); },
    aosJson: async (args: string[]) => {
      calls.push(args);
      const next = answers.shift();
      const a = typeof next === "function" ? next(args) : next ?? { code: 1, stderr: "aos: no answer scripted\n" };
      return { code: 0, stdout: "", stderr: "", timedOut: false, json: null, ...a };
    },
    terminalPool: {
      defaults: { shell: "/bin/sh" },
      lastLaunch: null as unknown,
      create(o: { cwd: string; meta: { host: string } }) {
        const t = { cwd: o.cwd, host: o.meta.host, typed: [] as string[] };
        terminals.push(t);
        return { id: `t${++n}`, write: (s: string) => { t.typed.push(s); } };
      },
      createAgent(o: { spec: { host: string; configDir?: string | null }; place: { dir: string }; shell?: string }) {
        agents.push(o);
        return { session: { id: `t${++n}`, write: () => {}, get isClosed() { return closed; } }, ready: attach() };
      },
      select() {},
      trigger(name: string, note: unknown) { if (name === "session-launched") launched.push(note); },
    },
  };
  const launcher = new TerminalLauncher(plugin as never);
  return {
    root, vault, calls, scans, terminals, agents, launched, launcher,
    setAttach: (f: typeof attach) => { attach = f; },
    setClosed: (c: boolean) => { closed = c; },
    ws: (...rel: string[]) => path.join(vault, "workspaces", ...rel),
  };
}

const sha = (p: string): string => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const REFUSED = "UniDeX: spawn node … refused; no write surface that allows it is on";

test("createAndLaunch: `workspace new <slug> --json` (no --pin) through the spaces surface, then the host in the slug it answers", async () => {
  const w = world([(args) => { fs.mkdirSync(w.ws(args[2])); return { json: { ok: true, slug: args[2], name: args[2] } }; }]);
  const r = await w.launcher.createAndLaunch("Tide chart", "shell", false);
  assert.deepEqual(w.calls, [["workspace", "new", "tide-chart", "--json"]]);
  assert.equal(r.place.dir, w.ws("tide-chart"));
  assert.deepEqual(w.terminals.map((t) => t.cwd), [w.ws("tide-chart")]);
  assert.ok(w.scans.includes("brain/scripts/scan-vault.js"), "Spaces' list is rebuilt");
  assert.deepEqual(fs.readdirSync(w.ws("tide-chart")), [], "the page wrote nothing itself: the runtime made it");
  // --git rides the same verb.
  const g = world([(args) => { fs.mkdirSync(g.ws(args[2])); return { json: { ok: true, slug: args[2] } }; }]);
  await g.launcher.createAndLaunch("kelp", "shell", true);
  assert.deepEqual(g.calls, [["workspace", "new", "kelp", "--git", "--json"]]);
});

test("createAndLaunch: the slug the runtime answers is checked against KEBAB again; no terminal opens for another", async () => {
  const w = world([{ json: { ok: true, slug: "../evil" } }]);
  await assert.rejects(() => w.launcher.createAndLaunch("tide", "shell", false), /answered a name Spaces will not use/);
  assert.deepEqual(w.terminals, []);
});

test("createAndLaunch: an existing workspace is opened, never made again", async () => {
  const w = world([]);
  fs.mkdirSync(w.ws("tide-chart"));
  await w.launcher.createAndLaunch("tide chart", "shell", false);
  assert.deepEqual(w.calls, [], "no verb");
  assert.deepEqual(w.terminals.map((t) => t.cwd), [w.ws("tide-chart")]);
});

test("createAndLaunch: a refused spawn (surface off) or an old runtime takes today's HostFs path; a refusal never does", async () => {
  const off = world([{ code: -1, error: REFUSED }]);
  await off.launcher.createAndLaunch("tide", "shell", false);
  assert.deepEqual(fs.readdirSync(off.ws("tide")).sort(), ["AGENTS.md", "CLAUDE.md", "README.md"], "HostFs made it with its stubs");
  assert.deepEqual(off.terminals.map((t) => t.cwd), [off.ws("tide")]);
  const old = world([{ code: 2, stderr: "aos: unknown flag --json\nusage:\n" }]);
  await old.launcher.createAndLaunch("tide", "shell", false);
  assert.ok(fs.existsSync(old.ws("tide", "README.md")));
  // The runtime refused: its reason, and nothing made behind its back.
  const no = world([{ code: 1, stderr: "aos: refusing to make workspaces/tide: workspaces is not a plain folder\n" }]);
  await assert.rejects(() => no.launcher.createAndLaunch("tide", "shell", false), /workspaces is not a plain folder/);
  assert.ok(!fs.existsSync(no.ws("tide")));
  assert.deepEqual(no.terminals, []);
  // A refusal that echoes a chosen name ("unknown verb") is still a refusal, never an old runtime (verbResult).
  const named = world([{ code: 1, stderr: "aos: workspaces/unknown verb is a symlink, not a workspace folder\n" }]);
  await assert.rejects(() => named.launcher.createAndLaunch("unknown verb", "shell", false), /is a symlink/);
  assert.ok(!fs.existsSync(named.ws("unknown-verb")));
  // Today's path keeps the runtime's rule: a name an archived workspace holds is not made again.
  const held = world([{ code: -1, error: REFUSED }]);
  fs.mkdirSync(held.ws("_archive", "tide"), { recursive: true });
  await assert.rejects(() => held.launcher.createAndLaunch("tide", "shell", false), /held by an archived workspace/);
  assert.ok(!fs.existsSync(held.ws("tide")));
});

test("linkRepo: `workspace set <ws> --set {repo} --expect <hash> --json` to link and to clear; the runtime writes", async () => {
  const code = path.join(os.homedir(), "code-for-a-test-that-never-exists");
  // The fake runtime writes what `set` would, so the second call's --expect is the new file's hash.
  let file = "";
  const w = world([
    (args) => { fs.writeFileSync(file, `---\nrepo: ${JSON.parse(args[4]).repo}\n---\n`); return { json: { ok: true } }; },
    () => ({ json: { ok: true } }),
  ]);
  fs.mkdirSync(w.ws("tide"));
  file = w.ws("tide", "workspace.md");
  assert.equal(await w.launcher.linkRepo("tide", code), code);
  assert.deepEqual(w.calls[0], ["workspace", "set", "tide", "--set", JSON.stringify({ repo: "~/code-for-a-test-that-never-exists" }), "--expect", "none", "--json"]);
  const hash = sha(file);
  assert.equal(await w.launcher.linkRepo("tide", null), null);
  assert.deepEqual(w.calls[1], ["workspace", "set", "tide", "--set", '{"repo":""}', "--expect", hash, "--json"]);
  assert.equal(fs.readFileSync(file, "utf8"), "---\nrepo: ~/code-for-a-test-that-never-exists\n---\n", "the page wrote nothing itself");
});

test("linkRepo: a refused spawn writes repo: itself (the Files surface); a runtime refusal throws and writes nothing", async () => {
  const off = world([{ code: -1, error: REFUSED }]);
  fs.mkdirSync(off.ws("tide"));
  const code = path.join(os.homedir(), "code-for-a-test-that-never-exists");
  await off.launcher.linkRepo("tide", code);
  assert.match(fs.readFileSync(off.ws("tide", "workspace.md"), "utf8"), /repo: "~\/code-for-a-test-that-never-exists"/);
  const no = world([{ code: 1, stderr: "aos: repo must be an existing folder\n" }]);
  fs.mkdirSync(no.ws("tide"));
  await assert.rejects(() => no.launcher.linkRepo("tide", code), /existing folder/);
  assert.ok(!fs.existsSync(no.ws("tide", "workspace.md")));
});

test("setManifest: a compare-and-set miss reads the hash again and retries once; a second miss says so outside Draft's words", async () => {
  const stale = { code: 1, stderr: "aos: workspace.md changed: draft again\n" };
  const once = world([stale, { json: { ok: true } }]);
  fs.mkdirSync(once.ws("tide"));
  assert.equal((await once.launcher.setManifest("tide", { pinned: true })).ok, true);
  assert.equal(once.calls.length, 2);
  const twice = world([stale, stale]);
  fs.mkdirSync(twice.ws("tide"));
  const r = await twice.launcher.setManifest("tide", { pinned: true });
  assert.deepEqual([r.ok, !r.ok && r.reason, twice.calls.length], [false, "workspace.md changed meanwhile: try again", 2]);
});

const flush = async (): Promise<void> => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };

test("launch: an agent goes through the pool's createAgent (agent-computer D18); it settles at once, and the note follows, saying when the computer is off", async () => {
  const w = world([]);
  let answer: (v: { agent: boolean; reason: string | null }) => void = () => {};
  w.setAttach(() => new Promise((r) => { answer = r; }));
  const r = await w.launcher.launch({ host: "claude", picked: { kind: "vault", label: "Vault", dir: w.vault } });
  assert.equal(r.session.id, "t1", "settled while the agent still starts: the menu and the tab do not wait for main");
  assert.deepEqual(w.terminals, [], "no shell with a typed line");
  assert.deepEqual(w.agents.map((a) => [a.spec.host, a.place.dir, a.shell]), [["claude", w.vault, "/bin/sh"]]);
  assert.equal(w.agents[0].spec.configDir, path.join(w.root, "cfg"), "the config folder the line's prefix names, for main to set");
  assert.deepEqual(w.launched, []);
  answer({ agent: true, reason: null });
  await flush();
  assert.deepEqual((w.launched[0] as { text: string }).text, "Started Claude Code in Vault");
  w.setAttach(async () => ({ agent: false, reason: "Claude Code at /opt/claude isn't a supported install: unsigned" }));
  await w.launcher.launch({ host: "claude", picked: { kind: "vault", label: "Vault", dir: w.vault } });
  await flush();
  assert.equal((w.launched[1] as { text: string }).text, "Started Claude Code in Vault (the computer is off for this session: Claude Code at /opt/claude isn't a supported install: unsigned)");
});

test("launch: a terminal closed before its agent started gets no note", async () => {
  const w = world([]);
  let answer: (v: { agent: boolean; reason: string | null }) => void = () => {};
  w.setAttach(() => new Promise((r) => { answer = r; }));
  w.setClosed(true);
  await w.launcher.launch({ host: "claude", picked: { kind: "vault", label: "Vault", dir: w.vault } });
  answer({ agent: true, reason: null });
  await flush();
  assert.deepEqual(w.launched, []);
});

test("launch: a refused agent announces nothing: its terminal says why (TerminalPool.createAgent)", async () => {
  const w = world([]);
  w.setAttach(async () => { throw new Error("Claude Code did not start: a working directory that is not there"); });
  await w.launcher.launch({ host: "claude", picked: { kind: "vault", label: "Vault", dir: w.vault } });
  await flush();
  assert.deepEqual(w.launched, []);
  assert.equal(w.agents.length, 1);
});

/** The Node host with a pty whose agentFlags answers `noDaemon` (absent: a host that cannot say, outside the app). */
function flagsHost(noDaemon: boolean | null): string[] {
  const asked: string[] = [];
  const node = createNodeHost();
  const host: HudHost = {
    ...node,
    pty: { ...node.pty, ...(noDaemon === null ? {} : { agentFlags: async (h: "claude" | "codex") => { asked.push(h); return { noDaemon }; } }) },
  };
  setHudHost(host);
  return asked;
}

test("R70: a Codex launch asks main first whether its CLI runs without the shared background server; the spec, the preview and the argv agree", async () => {
  const asked = flagsHost(true);
  const w = world([]);
  assert.ok(!w.launcher.preview("codex").includes("--no-daemon"), "nothing known before main answers");
  await flush();
  assert.deepEqual(asked, ["codex"], "asked when the launcher is made, so the menu's first preview is already the line that runs");
  assert.match(w.launcher.preview("codex"), /^exec codex --no-daemon\b/);
  assert.equal(await w.launcher.refreshAgentFlags(), false, "the menu's own ask: unchanged");
  await w.launcher.launch({ host: "codex", picked: { kind: "vault", label: "Vault", dir: w.vault } });
  assert.equal((w.agents[0].spec as { noDaemon?: boolean }).noDaemon, true);
  assert.deepEqual(asked, ["codex", "codex", "codex"], "R79: every Codex launch asks main for its answer now");
  // Claude Code is never asked and never gets the flag.
  await w.launcher.launch({ host: "claude", picked: { kind: "vault", label: "Vault", dir: w.vault } });
  assert.deepEqual(asked, ["codex", "codex", "codex"]);
  assert.ok(!(w.agents[1].spec as { noDaemon?: boolean }).noDaemon);
  assert.ok(!w.launcher.preview("claude").includes("--no-daemon"));
});

test("R77: the spec carries the binary main probed, so a typed fallback names the flag only for that binary", async () => {
  const node = createNodeHost();
  setHudHost({ ...node, pty: { ...node.pty, agentFlags: async () => ({ noDaemon: true, bin: "/opt/homebrew/bin/codex" }) } });
  const w = world([]);
  await flush();
  await w.launcher.launch({ host: "codex", picked: { kind: "vault", label: "Vault", dir: w.vault } });
  const spec = w.agents[0].spec as { noDaemon?: boolean; probedBin?: string | null; bin?: string | null };
  assert.deepEqual([spec.noDaemon, spec.probedBin, spec.bin], [true, "/opt/homebrew/bin/codex", null]);
  setHudHost(createNodeHost());
});

test("R77: a launch with no answer yet waits for the ask already on its way, and asks nothing more", async () => {
  const asked: string[] = [];
  let answer!: (v: { noDaemon: boolean }) => void;
  const node = createNodeHost();
  setHudHost({ ...node, pty: { ...node.pty, agentFlags: (h: "claude" | "codex") => { asked.push(h); return new Promise((r) => { answer = r; }); } } });
  const w = world([]);
  const launched = w.launcher.launch({ host: "codex", picked: { kind: "vault", label: "Vault", dir: w.vault } });
  await flush();
  assert.deepEqual(asked, ["codex"], "the launcher's own ask at start, shared by the launch");
  assert.equal(w.agents.length, 0, "the launch waits for main's answer");
  answer({ noDaemon: true });
  await launched;
  assert.equal((w.agents[0].spec as { noDaemon?: boolean }).noDaemon, true);
  assert.deepEqual(asked, ["codex"]);
  setHudHost(createNodeHost());
});

/** A host whose agentFlags answers by the test's current `answer` per key (a function may throw: a failed ask), and
 *  records each ask as "codex" or "codex resume". */
function liveFlags(answer: (sub?: "resume") => { noDaemon: boolean; bin?: string | null } | Promise<{ noDaemon: boolean; bin?: string | null }>) {
  const asked: string[] = [];
  const node = createNodeHost();
  setHudHost({ ...node, pty: { ...node.pty, agentFlags: async (h: "claude" | "codex", sub?: "resume") => { asked.push(`${h}${sub ? ` ${sub}` : ""}`); return answer(sub); } } });
  return asked;
}
const VAULT_AT = (w: { vault: string }) => ({ kind: "vault" as const, label: "Vault", dir: w.vault });
const specOf = (w: { agents: Array<{ spec: unknown }> }, i: number) => w.agents[i].spec as { noDaemon?: boolean; probedBin?: string | null };

test("R79: ⌘T and Spaces launches ask main each time, so the line follows Settings ▸ Computer turned off and on again", async () => {
  let on = true;
  liveFlags(() => ({ noDaemon: on, bin: "/opt/homebrew/bin/codex" }));
  const w = world([]);
  await flush();
  on = false; // Settings ▸ Computer turned off after the launcher's first ask; no menu opened since
  await w.launcher.launch({ host: "codex", context: VAULT_AT(w) }); // ⌘T: the quick launch
  assert.ok(!specOf(w, 0).noDaemon, "⌘T: no flag once main says no");
  await w.launcher.launch({ host: "codex", picked: VAULT_AT(w), origin: "Spaces" });
  assert.ok(!specOf(w, 1).noDaemon, "Spaces: the same");
  on = true;
  await w.launcher.launch({ host: "codex", picked: VAULT_AT(w), origin: "Spaces" });
  assert.equal(specOf(w, 2).noDaemon, true, "turned on again: the flag is back without the menu");
  setHudHost(createNodeHost());
});

test("R79: every resume asks main for the resume key again", async () => {
  let on = true;
  const asked = liveFlags((sub) => ({ noDaemon: sub === "resume" && on, bin: "/opt/homebrew/bin/codex" }));
  const w = world([]);
  await flush();
  await w.launcher.launch({ host: "codex", picked: VAULT_AT(w), resume: "last" });
  on = false;
  await w.launcher.launch({ host: "codex", picked: VAULT_AT(w), resume: "last" });
  assert.deepEqual([specOf(w, 0).noDaemon, !!specOf(w, 1).noDaemon], [true, false]);
  assert.deepEqual(asked.filter((a) => a === "codex resume").length, 2);
  setHudHost(createNodeHost());
});

test("R79: a failed ask leaves no answer (never a no): the line goes without the flag and main's spawn answer fills it", async () => {
  let fail = false;
  liveFlags(() => { if (fail) throw new Error("the bridge failed"); return { noDaemon: true, bin: "/opt/homebrew/bin/codex" }; });
  const w = world([]);
  await flush();
  assert.match(w.launcher.preview("codex"), /--no-daemon/);
  fail = true;
  assert.equal(await w.launcher.refreshAgentFlags(), true, "the answer is gone, so the preview changes");
  assert.ok(!w.launcher.preview("codex").includes("--no-daemon"), "nothing known: no flag shown");
  await w.launcher.launch({ host: "codex", picked: VAULT_AT(w) });
  assert.ok(!specOf(w, 0).noDaemon, "launched without it");
  // Main refuses that line at spawn with its answer: the launcher keeps it (the pool relaunches the same spec with it).
  const onFlags = (w.agents[0] as unknown as { onFlags?: (f: { noDaemon: boolean; bin: string | null }) => void }).onFlags;
  assert.equal(typeof onFlags, "function", "the launch hands the pool a place for main's answer");
  onFlags!({ noDaemon: true, bin: "/opt/homebrew/bin/codex" });
  assert.match(w.launcher.preview("codex"), /--no-daemon/, "and the menu's preview follows main's answer");
  setHudHost(createNodeHost());
});

test("R79: a launch while the menu's refresh is on its way shares it; the menu refreshes both keys", async () => {
  const pending: Array<(v: { noDaemon: boolean; bin: string | null }) => void> = [];
  const asked = liveFlags(() => new Promise((r) => { pending.push(r); }));
  const w = world([]);
  await flush();
  pending.splice(0).forEach((r) => r({ noDaemon: false, bin: null })); // the launcher's own first ask
  await flush();
  asked.length = 0;
  const menu = w.launcher.refreshAll();
  await flush();
  assert.deepEqual(asked.sort(), ["codex", "codex resume"], "the menu asks for both keys");
  const launched = w.launcher.launch({ host: "codex", picked: VAULT_AT(w) });
  await flush();
  assert.deepEqual(asked.length, 2, "the launch shares the menu's ask on its way");
  pending.splice(0).forEach((r) => r({ noDaemon: true, bin: "/opt/homebrew/bin/codex" }));
  assert.equal(await menu, true);
  await launched;
  assert.equal(specOf(w, 0).noDaemon, true);
  setHudHost(createNodeHost());
});

test("R77: a resume line carries --no-daemon by what main says of `codex resume --help`, not the top level's", async () => {
  const asked: string[] = [];
  const node = createNodeHost();
  setHudHost({ ...node, pty: { ...node.pty, agentFlags: async (h: "claude" | "codex", sub?: "resume") => { asked.push(`${h}${sub ? ` ${sub}` : ""}`); return { noDaemon: sub !== "resume" }; } } });
  const w = world([]);
  await flush();
  assert.match(w.launcher.preview("codex"), /^exec codex --no-daemon\b/, "a new line: the top level lists it");
  await w.launcher.launch({ host: "codex", picked: { kind: "vault", label: "Vault", dir: w.vault }, resume: "last" });
  assert.ok(asked.includes("codex resume"), "a resume launch asks about the resume subcommand");
  assert.ok(!(w.agents[0].spec as { noDaemon?: boolean }).noDaemon, "its help lacks the flag here, so the resume line goes without it");
  assert.match(w.launcher.preview("codex"), /^exec codex --no-daemon\b/, "the new line keeps its own answer");
  setHudHost(createNodeHost());
});

test("R70: main answering false, or a host that cannot say, leaves the Codex line as before", async () => {
  flagsHost(false);
  const w = world([]);
  await w.launcher.launch({ host: "codex", picked: { kind: "vault", label: "Vault", dir: w.vault } });
  assert.ok(!(w.agents[0].spec as { noDaemon?: boolean }).noDaemon);
  assert.ok(!w.launcher.preview("codex").includes("--no-daemon"));
  flagsHost(null);
  const v = world([]);
  assert.equal(await v.launcher.refreshAgentFlags(), false);
  await v.launcher.launch({ host: "codex", picked: { kind: "vault", label: "Vault", dir: v.vault } });
  assert.ok(!(v.agents[0].spec as { noDaemon?: boolean }).noDaemon);
  setHudHost(createNodeHost());
});

test("spec: a model or access picked for one launch overrides the settings, on both hosts, through the existing flag builders (code-chat C12)", () => {
  const w = world([]);
  const id = "u2";
  const claude = w.launcher.spec("claude", { resume: { id }, model: "sonnet", access: "read" });
  assert.deepEqual([claude.model, claude.access], ["sonnet", "read"]);
  const a = launchArgs(claude);
  assert.deepEqual(a.slice(0, 4), ["--model", "sonnet", "--permission-mode", "plan"]);
  assert.deepEqual(a.slice(4, 6), ["--resume", id]);
  const codex = w.launcher.spec("codex", { resume: { id }, cwd: "/work/demo", model: "gpt-x", access: "edit" });
  assert.deepEqual(launchArgs(codex), ["resume", "-C", "/work/demo", id, "-m", "gpt-x", "-s", "workspace-write", "-a", "on-request"]);
  // No override: the settings' model and access, and a Codex resume passes neither (the thread keeps its own).
  assert.deepEqual(launchArgs(w.launcher.spec("codex", { resume: { id }, cwd: "/work/demo" })), ["resume", "-C", "/work/demo", id]);
  assert.equal(w.launcher.spec("claude", { resume: { id } }).model, null);
});
