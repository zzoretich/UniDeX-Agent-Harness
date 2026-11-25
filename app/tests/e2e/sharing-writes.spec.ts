// Skills and Agents sharing with its write surface on (AOS_APP_WRITE=sharing), the rows of app-smoke: Skills
// and Agents, on a machine with both session hosts (sharing on). unshare and share run `aos skills|agents exclude|include
// <id>`: the runtime rewrites brain/config.json's exclude list, then syncs, which removes the item's mirror in the other
// host's folder or writes it again. The tests read the config, the mirror and the runtime's cache after each click. An
// agent is shared or unshared from its profile in Agent Workspace (agent-workspace D11), whose header has sync now (D13).

import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, content, guardWrites, openTab, readVaultJson, shareBothHosts, useApp } from "./harness";

const app = useApp({ env: { AOS_APP_WRITE: "sharing" }, prepare: shareBothHosts });

type Kind = "skills" | "agents";
interface Row { id: string; status: string; on: Record<string, unknown> }
const C = (win: Page) => content(win);
const row = (win: Page, name: string) => C(win).locator(".aos-sk-row", { has: win.locator(".aos-sk-name > div:first-child", { hasText: new RegExp(`^${name}`) }) });
const toggle = (win: Page, name: string, label: "share" | "unshare") => row(win, name).locator(".aos-sk-actions a", { hasText: new RegExp(`^${label}$`) });

const CFG = FX.v("brain/config.json");
const config = () => fs.readFileSync(CFG, "utf8");
const pristineConfig = () => fs.readFileSync(path.join(FX.pristine, "vault", "brain", "config.json"), "utf8");
/** brain/config.json as `aos skills|agents exclude|include` writes it: the file with that kind's exclude list replaced, as 2-space JSON. */
function withExclude(kind: Kind, ids: string[]): string {
  const j = JSON.parse(pristineConfig()) as Record<string, Record<string, unknown>>;
  j[kind] = { ...j[kind], exclude: [...ids].sort() };
  return `${JSON.stringify(j, null, 2)}\n`;
}
const cache = (kind: Kind) => readVaultJson<Record<string, unknown> & { sync: { on: boolean; at: string } }>(`brain/_index/${kind}.json`);
const status = (kind: Kind, id: string) => (cache(kind)[kind] as Row[]).find((r) => r.id === id)?.status;

const skillMirror = (id: string) => path.join(FX.home, ".agents", "skills", id);
const agentMirror = (id: string) => path.join(FX.home, ".codex", "agents", `${id}.toml`);
/** Every file under a folder, relative path → bytes; symlinks by their target. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      const abs = path.join(dir, r);
      if (e.isSymbolicLink()) out[r] = `→ ${fs.readlinkSync(abs)}`;
      else if (e.isDirectory()) walk(r);
      else out[r] = fs.readFileSync(abs, "utf8");
    }
  };
  if (fs.existsSync(dir)) walk("");
  return out;
}

test.beforeEach(() => {
  // Each test ends where it began: nothing excluded, every mirror in place.
  expect(config()).toBe(pristineConfig());
});

test.afterEach(async () => {
  // Every spawn the tabs made ran, and nothing was written outside the runtime.
  expect(await guardWrites(app())).toEqual([]);
  expect((await app().guard()).filter((e) => e.kind === "spawn")).toEqual([]);
});

test("Skills & Agents is the one surface on: the status bar names it and what it may run", async () => {
  const { win } = app();
  const mode = win.locator(".aos-host-status .aos-host-mode");
  await expect(mode).toHaveText("WRITES: Skills & Agents");
  await expect(mode).toHaveAttribute("title", /^Skills & Agents: cli\/aos\.js\n/);
});

test("with both hosts, sharing is on: the note says so, each of your skills is on both, and only yours can be unshared (SK1)", async () => {
  const { win } = app();
  await openTab(win, "skills");
  await expect(C(win).locator(".aos-rt-count")).toHaveText(/^3 on both · 0 Claude Code only · 0 Codex only · \d+ from plugins$/);
  await expect(C(win).locator(".aos-rt-note").first()).toHaveText(/^sharing on — each host's skills are copied into the other at the end of every session · as of \d+[sm] ago$/);
  for (const name of ["chart-check", "release-notes", "tide-report"]) {
    await expect(row(win, name).locator(".aos-pulse-chip")).toHaveText("on both");
    await expect(row(win, name).locator(".aos-sk-pills .aos-pill")).toHaveText(["claude", "codex"]);
    await expect(row(win, name).locator(".aos-sk-pills .aos-pill.is-absent")).toHaveCount(0);
    await expect(toggle(win, name, "unshare")).toBeVisible();
  }
  // Plugin skills and built-ins are listed only.
  const listed = C(win).locator(".aos-sk-table").nth(1);
  await expect(listed.locator(".aos-sk-row").first()).toBeVisible();
  await expect(listed.locator(".aos-sk-actions a", { hasText: /^(un)?share$/ })).toHaveCount(0);
});

test("Skills: unshare records the exclusion and removes the Codex copy; share writes the copy again (SK5)", async () => {
  const { win } = app();
  await openTab(win, "skills");
  const dir = skillMirror("tide-report");
  const before = tree(dir);
  expect(Object.keys(before).sort()).toEqual([".aos-mirror.json", "SKILL.md"]);
  const source = fs.readFileSync(path.join(FX.claude, "skills", "tide-report", "SKILL.md"), "utf8");
  const others = () => ({ chart: tree(skillMirror("chart-check")), notes: tree(skillMirror("release-notes")) });
  const othersBefore = others();

  await toggle(win, "tide-report", "unshare").click();
  await expect(win.locator(".notice-container")).toContainText("▶ aos.js skills exclude tide-report");
  await expect.poll(config).toBe(withExclude("skills", ["tide-report"]));
  await expect.poll(() => fs.existsSync(dir)).toBe(false);
  await expect.poll(() => status("skills", "tide-report")).toBe("excluded");
  await expect(row(win, "tide-report")).toHaveClass(/is-off/);
  await expect(row(win, "tide-report").locator(".aos-pulse-chip")).toHaveText("not shared");
  await expect(row(win, "tide-report").locator(".aos-sk-pills .aos-pill", { hasText: /^codex$/ })).toHaveClass(/is-absent/);
  await expect(C(win).locator(".aos-rt-count")).toHaveText(/^2 on both · 1 Claude Code only · 0 Codex only/);
  // The source is Claude Code's own skill: never touched. Neither are the other mirrors.
  expect(fs.readFileSync(path.join(FX.claude, "skills", "tide-report", "SKILL.md"), "utf8")).toBe(source);
  expect(others()).toEqual(othersBefore);

  await toggle(win, "tide-report", "share").click();
  await expect(win.locator(".notice-container")).toContainText("▶ aos.js skills include tide-report");
  await expect.poll(config).toBe(pristineConfig());
  await expect.poll(() => status("skills", "tide-report")).toBe("universal");
  await expect(row(win, "tide-report")).not.toHaveClass(/is-off/);
  await expect(row(win, "tide-report").locator(".aos-pulse-chip")).toHaveText("on both");
  // The copy is written fresh: the same SKILL.md; the sidecar differs only in `at`, when it was written.
  const after = tree(dir);
  expect(after["SKILL.md"]).toBe(before["SKILL.md"]);
  const side = (t: Record<string, string>) => { const { at, ...rest } = JSON.parse(t[".aos-mirror.json"]) as Record<string, unknown>; void at; return rest; };
  expect(side(after)).toEqual(side(before));
  expect(others()).toEqual(othersBefore);
});

test.describe("an agent's profile in Agent Workspace", () => {
  // AW16: unshare removes the Codex agent file; share writes it back byte for byte.
  test("unshare / share", async () => {
    const { win } = app();
    await openTab(win, "agent-teams");
    await expect(C(win).locator(".aos-aw-sharing")).toHaveText(/^sharing on · as of \d+[sm] ago$/);
    await C(win).locator(".aos-aw-tree .aos-aw-row[data-key='agent:team-reviewer']").first().click();
    const pane = C(win).locator(".aos-aw-pane[data-node='agent:team-reviewer']");
    const hosts = pane.locator(".aos-aw-sec[data-sec='hosts']");
    const shareButton = (label: "share" | "unshare") => hosts.locator("button.aos-aw-share", { hasText: new RegExp(`^${label}$`) });
    const file = agentMirror("team-reviewer");
    const before = fs.readFileSync(file, "utf8");
    expect(before).toContain("# aos-mirror: ");
    const others = () => Object.fromEntries(["field-researcher", "survey-lead", "team-builder", "team-lead"].map((id) => [id, fs.readFileSync(agentMirror(id), "utf8")]));
    const othersBefore = others();
    await expect(hosts.locator(".aos-aw-sharechip")).toHaveText("on both");
    await expect(hosts.locator(".aos-aw-hostrow[data-host='codex'] .aos-aw-hostvia")).toHaveText("translated copy");

    await shareButton("unshare").click();
    await expect(win.locator(".notice-container")).toContainText("▶ aos.js agents exclude team-reviewer");
    await expect.poll(config).toBe(withExclude("agents", ["team-reviewer"]));
    await expect.poll(() => fs.existsSync(file)).toBe(false);
    await expect.poll(() => status("agents", "team-reviewer")).toBe("excluded");
    await expect(hosts.locator(".aos-aw-sharechip")).toHaveText("not shared");
    await expect(pane.locator(".aos-aw-hostpill[data-host='codex']")).toHaveClass(/is-absent/);
    expect(fs.existsSync(path.join(FX.claude, "agents", "team-reviewer.md"))).toBe(true);
    expect(others()).toEqual(othersBefore);

    await shareButton("share").click();
    await expect(win.locator(".notice-container")).toContainText("▶ aos.js agents include team-reviewer");
    await expect.poll(config).toBe(pristineConfig());
    await expect.poll(() => status("agents", "team-reviewer")).toBe("universal");
    // An agent's mirror carries no timestamp: it comes back byte for byte.
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    await expect(hosts.locator(".aos-aw-sharechip")).toHaveText("on both");
    await expect(pane.locator(".aos-aw-hostpill[data-host='codex']")).toHaveClass(/is-on/);
    expect(others()).toEqual(othersBefore);
  });
});

test("sync now runs the runtime's sync and the list re-renders from its cache (SK2, AW3)", async () => {
  const { win } = app();
  // Skills: its tab's own sync now.
  await openTab(win, "skills");
  const skillsAt = cache("skills").sync.at;
  await C(win).locator(".aos-rt-actions button", { hasText: "sync now" }).click();
  await expect(win.locator(".notice-container")).toContainText("▶ aos.js skills sync");
  await expect.poll(() => cache("skills").sync.at, { timeout: 30_000 }).not.toBe(skillsAt);
  await expect(C(win).locator(".aos-rt-note").first()).toHaveText(/ · as of \d+s ago$/);
  // Agents: the Agent Workspace header's sync now (agent-workspace D13), and its sharing state's age.
  await openTab(win, "agent-teams");
  const agentsAt = cache("agents").sync.at;
  await C(win).locator("button.aos-aw-sync").click();
  await expect(win.locator(".notice-container")).toContainText("▶ aos.js agents sync");
  await expect.poll(() => cache("agents").sync.at, { timeout: 30_000 }).not.toBe(agentsAt);
  await expect(C(win).locator(".aos-aw-sharing")).toHaveText(/^sharing on · as of \d+s ago$/);
});

test("with only Skills & Agents on, other surfaces stay refused: a To-Do tick cannot write TODO.md", async () => {
  const h = app();
  const before = fs.readFileSync(FX.v("TODO.md"), "utf8");
  await openTab(h.win, "todo");
  await content(h.win).locator(".aos-td-row", { hasText: "Call the chart vendor" }).locator(".aos-td-check").click();
  await expect.poll(() => guardWrites(h)).toEqual(["write TODO.md"]);
  expect(fs.readFileSync(FX.v("TODO.md"), "utf8")).toBe(before);
  await h.win.evaluate(() => { (window as unknown as { aosHost: { guard: { log: unknown[] } } }).aosHost.guard.log.length = 0; });
});
