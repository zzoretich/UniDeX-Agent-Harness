// UniDeX 2.0, PR 4 (spec 2026-10-14-local-first A6, A7): a prompt routine's engine and model in the Routines editor
// (app-smoke: Routines — engines). The engine select offers the default runner, the local engine when it is set up,
// and only the enabled hosts; the model select lists that engine's models from files the runtime writes (the local
// engine's last check in provider-state.json, Claude Code's model list, the Codex catalog) and never asks an engine
// itself. Four machines: the fixture's (Claude Code only, no provider), a Codex-only one, one with the local engine set
// up and both hosts, where a local routine is created and a skipped run (the engine down) shows on its row, and one
// with no agent CLI at all.

import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, appEnv, content, drawer, expectNoErrors, guardWrites, openTab, readVaultJson, useApp } from "./harness";
import { routineToFile } from "../../../obsidian-plugin/src/data/routines";
import { CLAUDE_MODELS, SMALL_MODEL_NOTE, WRITES_NOTE } from "../../../obsidian-plugin/src/data/routineEngines";

const C = (win: Page) => content(win);
const field = (win: Page, label: RegExp) => drawer(win).locator(".aos-rt-field", { hasText: label });
const engineSel = (win: Page) => drawer(win).locator("select.aos-rt-engineselect");
const modelSel = (win: Page) => drawer(win).locator("select.aos-rt-model");
const options = (sel: ReturnType<typeof engineSel>) => sel.locator("option");
const row = (win: Page, slug: string) => C(win).locator(".aos-rt-row", { has: win.locator(".aos-rt-slug", { hasText: new RegExp(`^${slug}( · guarded)?$`) }) });
const close = (win: Page) => drawer(win).locator(".aos-wb-draweractions a", { hasText: "✕" }).click();
const editJson = (file: string, fn: (j: Record<string, any>) => void) => {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  fn(j);
  fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
};
const agenticos = path.join(FX.claude, "agenticos.json");

test.describe("Claude Code only, no provider (the fixture)", () => {
  const app = useApp();

  test("a prompt row names its engine; + new offers the default runner and Claude Code, with Claude's models", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "routines");
    const writes = await guardWrites(h);
    const pill = row(win, "weekly-digest").locator(".aos-rt-engine");
    await expect(pill).toHaveText("auto");
    await expect(pill).toHaveAttribute("title", "engine: routines.runner (auto)");
    await expect(row(win, "nightly-scan").locator(".aos-rt-engine")).toHaveCount(0);   // a command has no engine
    await C(win).locator(".aos-rt-actions button", { hasText: "+ new" }).click();
    await expect(options(engineSel(win))).toHaveText(["Default (routines.runner)", "Claude Code"]);
    await expect(engineSel(win)).toHaveValue("");
    await expect(engineSel(win)).toHaveAttribute("data-tour", "routines-engine");
    await expect(options(modelSel(win))).toHaveText(["claude.model (haiku)", ...CLAUDE_MODELS]);
    await expect(field(win, /^effort/)).toBeVisible();
    await expect(field(win, /^budget USD per run/)).toBeVisible();
    await expect(drawer(win).locator(".aos-rt-enginenote")).toHaveCount(0);
    await modelSel(win).selectOption("sonnet");
    await engineSel(win).selectOption("claude");
    await expect(modelSel(win)).toHaveValue("", { timeout: 2000 });   // a model belongs to one engine: picking another clears it
    await expect(options(modelSel(win)).first()).toHaveText("claude.model (haiku)");
    await close(win);
    expect(await guardWrites(h)).toEqual(writes);
    expectNoErrors(h);
  });

  test("an existing routine without an engine opens on Default; a duty or a command shows no engine", async () => {
    const { win } = app();
    await row(win, "weekly-digest").locator(".aos-rt-rowactions a", { hasText: "✎" }).click();
    await expect(engineSel(win)).toHaveValue("");
    await expect(modelSel(win)).toHaveValue("");
    await field(win, /^kind/).locator("select").selectOption("command");
    await expect(engineSel(win)).toHaveCount(0);
    await close(win);
    await row(win, "monitor").locator(".aos-rt-rowactions a", { hasText: "✎" }).click();
    await expect(engineSel(win)).toHaveCount(0);
    await close(win);
  });
});

test.describe("a Codex-only machine", () => {
  const app = useApp({
    prepare: () => {
      editJson(agenticos, (j) => { j.hosts.claude.enabled = false; j.hosts.codex.enabled = true; });
      // A routine that named Claude Code before Claude was turned off: it keeps its engine, marked.
      fs.writeFileSync(FX.v("brain/routines/claude-brief.md"), '---\nschema: 1\nname: Claude brief\nkind: prompt\nschedule: "0 8 * * *"\nenabled: false\nengine: claude\nmodel: sonnet\n---\nBrief me.\n');
    },
  });

  test("the engine select offers Codex and never Claude Code; Codex's models start from its own default", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "routines");
    await C(win).locator(".aos-rt-actions button", { hasText: "+ new" }).click();
    await expect(options(engineSel(win))).toHaveText(["Default (routines.runner)", "Codex"]);
    await engineSel(win).selectOption("codex");
    await expect(options(modelSel(win)).first()).toHaveText("Codex's own default");
    await expect(modelSel(win)).toHaveValue("");
    await expect(options(modelSel(win))).not.toContainText(["haiku"]);
    await expect(field(win, /^effort/)).toBeVisible();
    await close(win);
    expectNoErrors(h);
  });

  test("a routine pinned to a host this machine lacks keeps its engine and model, marked", async () => {
    const { win } = app();
    await expect(row(win, "claude-brief").locator(".aos-rt-engine")).toHaveText("claude");
    await row(win, "claude-brief").locator(".aos-rt-rowactions a", { hasText: "✎" }).click();
    await expect(options(engineSel(win))).toHaveText(["Default (routines.runner)", "Claude Code (not enabled here)", "Codex"]);
    await expect(engineSel(win)).toHaveValue("claude");
    await expect(modelSel(win)).toHaveValue("sonnet");
    await close(win);
  });
});

test.describe("the local engine set up, both hosts, the Routines surface on", () => {
  const at = () => new Date().toISOString();
  const app = useApp({
    env: { AOS_APP_WRITE: "routines" },
    prepare: () => {
      // Provider local at an address nothing answers (port 9 refuses at once); its last check, as provider.js caches it,
      // listed three models. Both hosts on.
      editJson(agenticos, (j) => {
        Object.assign(j, { provider: "local", local: { engine: "ollama", url: "http://127.0.0.1:9" } });
        j.hosts.claude.enabled = true; j.hosts.codex.enabled = true;
      });
      editJson(FX.v("brain/_index/provider-state.json"), (j) => {
        Object.assign(j, { name: "ollama", reason: "local-ready", localReason: "local-ready", model: "qwen3.5:4b", checkedAt: at(),
          local: { engine: "ollama", url: "http://127.0.0.1:9", reachable: true, models: ["qwen3.5:4b", "qwen3.5:9b", "qwen3-embedding:0.6b"], checkedAt: at() } });
      });
      // A local routine run by the runtime itself while the engine is down: run-routine.js records the skip.
      fs.writeFileSync(FX.v("brain/routines/tide-local.md"), '---\nschema: 1\nname: Tide local\nkind: prompt\nschedule: "0 6 * * *"\nenabled: true\nengine: local\n---\nSummarise the tide notes.\n');
      editJson(FX.v("brain/_index/routines.json"), (j) => { j.synced["tide-local"] = "prompt|0 6 * * *|on"; });
      const r = spawnSync(process.execPath, [FX.v("brain/scripts/routines/run-routine.js"), "tide-local", "--manual"], { env: appEnv({ AOS_HEADLESS: undefined }), encoding: "utf8" });
      if (r.status !== 0 || !/skipped — local-down: Ollama at http:\/\/127\.0\.0\.1:9 is not answering/.test(r.stdout)) throw new Error(`run-routine: ${r.status} ${r.stdout} ${r.stderr}`);
    },
  });

  test("a local routine's row says it was skipped because the engine is down; nothing ran or was spent", async () => {
    const { win } = app();
    await openTab(win, "routines");
    const r = row(win, "tide-local");
    await expect(r.locator(".aos-rt-engine")).toHaveText("local");
    await expect(r.locator(".aos-rt-last")).toHaveText(/^skipped \d+s ago · local-down$/);
    await expect(r.locator(".aos-rt-last")).toHaveAttribute("title", "local-down: Ollama at http://127.0.0.1:9 is not answering — the next fire tries again");
    const st = readVaultJson<{ routines: Record<string, { lastRunAt?: string | null }> }>("brain/_index/routines.json");
    expect(st.routines["tide-local"].lastRunAt ?? null).toBeNull();
  });

  test("+ new starts on the local engine: its pulled models, the small-model note, turns, writes and output; create writes the file", async () => {
    const h = app();
    const { win } = h;
    await C(win).locator(".aos-rt-actions button", { hasText: "+ new" }).click();
    await expect(options(engineSel(win))).toHaveText(["Default (routines.runner)", "Local · this Mac", "Claude Code", "Codex"]);
    await expect(engineSel(win)).toHaveValue("local");
    await expect(options(modelSel(win))).toHaveText(["This Mac's model (qwen3.5:4b)", "qwen3.5:4b", "qwen3.5:9b"]);
    await expect(drawer(win).locator(".aos-rt-enginenote")).toHaveText(SMALL_MODEL_NOTE);
    await expect(field(win, /^effort/)).toHaveCount(0);
    await expect(field(win, /^budget USD/)).toHaveCount(0);
    await field(win, /^name/).locator("input").fill("Harbor digest");
    await field(win, /^schedule \(cron/).locator("input").fill("0 18 * * 1-5");
    await modelSel(win).selectOption("qwen3.5:9b");
    await drawer(win).locator("input.aos-rt-maxturns").fill("8");
    await drawer(win).locator("input.aos-rt-output").fill("notify");
    await drawer(win).locator("textarea.aos-rt-body").fill("Digest the harbor notes into notes/digests/.");
    // What feeds hosted sessions is off limits to a local routine: the note says so, and create refuses it.
    await expect(drawer(win).locator(".aos-rt-writesnote")).toHaveText(WRITES_NOTE);
    await drawer(win).locator("textarea.aos-rt-writes").fill("notes/digests/\nbrain/memory/\n");
    await drawer(win).locator(".aos-capture-actions button", { hasText: "create" }).click();
    await expect(drawer(win).locator(".aos-rt-errors")).toHaveText("invalid routine: writes: brain/memory/ is off limits to a local routine (brain/memory/: memories feed every session)");
    expect(fs.existsSync(FX.v("brain/routines/harbor-digest.md"))).toBe(false);
    // So is what the runner refuses when the routine runs (lib/write-areas.js): refused here first, with its reason.
    await drawer(win).locator("textarea.aos-rt-writes").fill("notes/digests/\nworkspaces/harbor/\n");
    await drawer(win).locator(".aos-capture-actions button", { hasText: "create" }).click();
    await expect(drawer(win).locator(".aos-rt-errors")).toHaveText("invalid routine: writes: workspaces/harbor/ is off limits to a local routine (guarded (workspaces/))");
    await drawer(win).locator("textarea.aos-rt-writes").fill("notes/digests/\n");
    await drawer(win).locator("input.aos-rt-output").fill("brain/routines/digest.md");
    await drawer(win).locator(".aos-capture-actions button", { hasText: "create" }).click();
    await expect(drawer(win).locator(".aos-rt-errors")).toHaveText("invalid routine: output: brain/routines/digest.md is off limits to a local routine (guarded (brain/routines/))");
    expect(fs.existsSync(FX.v("brain/routines/harbor-digest.md"))).toBe(false);
    await drawer(win).locator("input.aos-rt-output").fill("notify");
    await drawer(win).locator("textarea.aos-rt-writes").fill("notes/digests/\nbrain/reflections/*.md\n");
    await drawer(win).locator(".aos-capture-actions button", { hasText: "create" }).click();
    const want = routineToFile({
      slug: "harbor-digest", schema: 1, name: "Harbor digest", kind: "prompt", schedule: "0 18 * * 1-5", enabled: true,
      engine: "local", model: "qwen3.5:9b", maxTurns: 8, writes: ["notes/digests/", "brain/reflections/*.md"], output: "notify",
      body: "Digest the harbor notes into notes/digests/.",
    });
    expect(want).toBe('---\nschema: 1\nname: Harbor digest\nkind: prompt\nschedule: "0 18 * * 1-5"\nenabled: true\nengine: local\nmodel: "qwen3.5:9b"\nmaxTurns: 8\nwrites: [notes/digests/, "brain/reflections/*.md"]\noutput: notify\n---\n\nDigest the harbor notes into notes/digests/.\n');
    await expect.poll(() => { try { return fs.readFileSync(FX.v("brain/routines/harbor-digest.md"), "utf8"); } catch { return null; } }).toBe(want);
    await expect(row(win, "harbor-digest").locator(".aos-rt-engine")).toHaveText("local");
    // Switching a local routine to a host drops the local agent's fields and brings back effort and budget.
    await row(win, "harbor-digest").locator(".aos-rt-rowactions a", { hasText: "✎" }).click();
    await expect(engineSel(win)).toHaveValue("local");
    await expect(modelSel(win)).toHaveValue("qwen3.5:9b");
    await expect(drawer(win).locator("textarea.aos-rt-writes")).toHaveValue("notes/digests/\nbrain/reflections/*.md");
    await engineSel(win).selectOption("codex");
    await expect(drawer(win).locator("textarea.aos-rt-writes")).toHaveCount(0);
    await expect(field(win, /^effort/)).toBeVisible();
    await close(win);
    expectNoErrors(h);
  });
});

test.describe("no agent CLI: the local engine alone", () => {
  const app = useApp({
    prepare: () => {
      editJson(agenticos, (j) => {
        Object.assign(j, { provider: "local", local: { engine: "ollama", url: "http://127.0.0.1:9" } });
        j.hosts.claude.enabled = false; j.hosts.codex.enabled = false;
      });
    },
  });

  test("the editor offers the default runner and Local only, and a local routine's model starts on this Mac's", async () => {
    const h = app();
    const { win } = h;
    await openTab(win, "routines");
    await expect(row(win, "weekly-digest").locator(".aos-rt-engine")).toHaveText("auto");
    await C(win).locator(".aos-rt-actions button", { hasText: "+ new" }).click();
    await expect(options(engineSel(win))).toHaveText(["Default (routines.runner)", "Local · this Mac"]);
    await expect(engineSel(win)).toHaveValue("local");
    await expect(options(modelSel(win)).first()).toHaveText(/^This Mac's model \(/);
    await expect(drawer(win).locator(".aos-rt-enginenote")).toBeVisible();
    await close(win);
    expectNoErrors(h);
  });
});
