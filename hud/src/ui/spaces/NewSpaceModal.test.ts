import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import type * as New from "./NewSpaceModal";
import type { TermHostChoice } from "../../data/terminalLaunch";

// NewSpaceModal.ts draws with Obsidian's Modal, and the obsidian package ships types only: under node:test "obsidian"
// resolves to a stub, so the dialog's model (spaces-redesign D15) loads without a DOM.
const STUB = "obsidian-stub";
const M = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string };
const resolve = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "obsidian" ? STUB : resolve.call(this, request, ...rest);
};
class Stub {}
require.cache[STUB] = { id: STUB, filename: STUB, loaded: true, exports: { Modal: Stub, FuzzySuggestModal: Stub, Notice: Stub, setIcon: () => {} } } as unknown as NodeJS.Module;
const {
  CLONE_URL_HINT, SPACE_TEMPLATES, cloneLine, defaultOpenWith, githubCloneUrl, newSpaceArgs, newSpaceName, openWithOptions, renameName,
} = require("./NewSpaceModal") as typeof New;

const HOME = "/home/demo";
const VAULT = "/home/demo/vault";
const O = { vault: VAULT, home: HOME, existing: ["site", "Example Workspace", "scratch"], archived: ["old-site"] };
/** GitHub's SSH form, built so no address-shaped text sits in the source. */
const ssh = (path: string): string => `git${String.fromCharCode(64)}github.com:${path}`;

test("the name shows the folder it makes; reserved, scratch, existing, archived and too-long names say why not", () => {
  assert.deepEqual(newSpaceName("Trip Planner", O), { slug: "trip-planner", where: "~/vault/workspaces/trip-planner", problem: null });
  assert.deepEqual(newSpaceName("", O), { slug: "", where: null, problem: "Type a name" });
  assert.equal(newSpaceName("!!!", O).problem, "Use a letter or digit");
  assert.match(newSpaceName("research", O).problem ?? "", /reserved/);
  assert.match(newSpaceName("_archive", O).problem ?? "", /reserved/);
  assert.match(newSpaceName("Scratch", O).problem ?? "", /shared Scratch/);
  assert.equal(newSpaceName("Site", O).problem, "workspaces/site already exists: pick it in the list");
  assert.equal(newSpaceName("Old Site", O).problem, "An archived workspace holds old-site: restore it instead");
  assert.equal(newSpaceName("a".repeat(65), O).problem, "Use at most 64 letters, digits and dashes");
  assert.equal(newSpaceName("a".repeat(64), O).problem, null);
  assert.equal(newSpaceName("x", { ...O, home: "" }).where, "/home/demo/vault/workspaces/x");
});

test("the three templates, and the verb each runs: Blank and Code repo pinned, Clone empty (its line pins it)", () => {
  assert.deepEqual(SPACE_TEMPLATES.map((t) => [t.id, t.label]), [["blank", "Blank folder"], ["code", "Code repo"], ["clone", "Clone from GitHub"]]);
  assert.deepEqual(newSpaceArgs("blank", "trip-planner"), ["workspace", "new", "trip-planner", "--pin", "--json"]);
  assert.deepEqual(newSpaceArgs("code", "trip-planner"), ["workspace", "new", "trip-planner", "--git", "--pin", "--json"]);
  assert.deepEqual(newSpaceArgs("clone", "trip-planner"), ["workspace", "new", "trip-planner", "--empty", "--json"]);
  assert.throws(() => newSpaceArgs("blank", "Trip Planner"));
});

test("the GitHub URL rule: https and SSH forms of one owner and repository, nothing else", () => {
  for (const ok of [
    "https://github.com/octo/hello", "https://github.com/octo/hello.git", "https://github.com/o-1/r.e_p-o",
    "  https://github.com/octo/hello  ", "https://github.com/octo/hello\n", ssh("octo/hello.git"), ssh("o/.hidden.git"), "https://github.com/octo/...x",
  ]) assert.equal(githubCloneUrl(ok), ok.trim(), ok);
  for (const bad of [
    "https://github.com/octo/hello world", "https://github.com/octo/'hello'", "https://github.com/octo/\"x\"",
    "https://github.com/octo/..", "https://github.com/octo/.", "https://github.com/octo/...git", "https://github.com/octo/..git",
    "https://github.com/octo/../etc", "https://github.com/octo", "https://github.com/-octo/x", "https://gitlab.com/octo/hello",
    "https://github.com.evil.com/octo/hello", "http://github.com/octo/hello", "ext::sh -c touch% /tmp/pwned",
    "--upload-pack=touch /tmp/x", "https://github.com/octo/hello --upload-pack=x", "https://github.com/octo/hello;rm -rf ~",
    "https://github.com/octo/hel\nlo", "file:///etc", ssh("octo/hello"), ssh("../x.git"), ssh("octo/...git"),
    `evil${String.fromCharCode(64)}github.com:octo/hello.git`, "https://x" + String.fromCharCode(64) + "github.com/octo/hello",
    "https://github.com/" + "a".repeat(40) + "/x", "",
  ]) assert.equal(githubCloneUrl(bad), null, JSON.stringify(bad));
});

test("the clone line: the URL quoted, only a KEBAB slug, stubs pinned after the clone; anything else throws", () => {
  assert.equal(cloneLine("https://github.com/octo/hello.git", "hello"), " git clone -- 'https://github.com/octo/hello.git' . && aos workspace stubs hello --pin");
  assert.equal(cloneLine(` ${ssh("octo/hello.git")} `, "my-hello"), ` git clone -- '${ssh("octo/hello.git")}' . && aos workspace stubs my-hello --pin`);
  assert.throws(() => cloneLine("https://github.com/octo/hello", "Hello; rm"), /workspace name/);
  assert.throws(() => cloneLine("https://github.com/octo/hello", "-x"));
  assert.throws(() => cloneLine("https://github.com/octo/it's", "hello"), (e: Error) => e.message.includes(CLONE_URL_HINT));
});

function choices(o: { claude?: "on" | "off" | "out"; codex?: "on" | "off" | "out" } = {}): TermHostChoice[] {
  const one = (host: "claude" | "codex", label: string, s: "on" | "off" | "out" = "on"): TermHostChoice => ({
    host, label, hidden: s === "off", ready: s === "on", bin: null, reason: s === "out" ? `${label} is not logged in` : s === "off" ? `${label} is off` : null,
  });
  return [one("claude", "Claude Code", o.claude), one("codex", "Codex", o.codex), { host: "shell", label: "Shell", hidden: false, ready: true, reason: null, bin: null }];
}

test("Open with lists the hosts that are on and Terminal, and starts on the one ⌘T starts (host parity)", () => {
  const both = openWithOptions(choices());
  assert.deepEqual(both.map((o) => [o.host, o.label, o.disabled]), [["claude", "Claude Code", false], ["codex", "Codex", false], ["shell", "Terminal", false]]);
  assert.equal(defaultOpenWith(both, "codex"), "codex");
  assert.equal(defaultOpenWith(both, null), "claude");
  // A Codex-only machine: no Claude Code row, and Codex by default.
  const codexOnly = openWithOptions(choices({ claude: "off" }));
  assert.deepEqual(codexOnly.map((o) => o.host), ["codex", "shell"]);
  assert.equal(defaultOpenWith(codexOnly, "claude"), "codex");
  // Not logged in: offered, off, with its reason; the default skips it.
  const out = openWithOptions(choices({ claude: "out" }));
  assert.deepEqual(out[0], { host: "claude", label: "Claude Code", disabled: true, reason: "Claude Code is not logged in" });
  assert.equal(defaultOpenWith(out, "claude"), "codex");
  assert.equal(defaultOpenWith(openWithOptions(choices({ claude: "off", codex: "off" })), null), "shell");
  assert.equal(defaultOpenWith(both, "shell"), "shell");
});

test("renameName: New space's rules in Rename's words; its name now and an empty field are quiet hints, not errors", () => {
  assert.deepEqual(renameName("harbor-map", "harbor-map", O), { slug: "harbor-map", problem: "That is its name now", quiet: true });
  assert.deepEqual(renameName("  ", "harbor-map", O), { slug: "", problem: "Type a new name", quiet: true });
  assert.deepEqual(renameName("Site", "harbor-map", O), { slug: "site", problem: "workspaces/site already exists: pick another name", quiet: false });
  assert.deepEqual(renameName("Old Site", "harbor-map", O), { slug: "old-site", problem: "An archived workspace holds old-site: pick another name", quiet: false });
  assert.deepEqual(renameName("Harbor Chart", "harbor-map", O), { slug: "harbor-chart", problem: null, quiet: false });
  assert.match(renameName("research", "harbor-map", O).problem ?? "", /reserved/);
});
