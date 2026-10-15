// Sessions on a fresh install's first launch (local-first A17, a follow-up to PR 2): under provider local nothing asks the
// hosts whether they are signed in until the runtime's free check runs, so the first launch found no login recorded and
// drew the rail without Sessions, which came only with the next launch. The fixture is that install: provider local with
// the engine nowhere, Claude Code on and signed in (its stub answers `claude auth status` after a second, so the rail is
// drawn first), no login in provider-state.json, and a sweep stamped a moment ago (the throttle that once skipped the
// check). Sessions joins the rail once the check answers, with no relaunch.

import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, content, expectNoErrors, openTab, rail, useApp } from "./harness";

const STUB = path.join(FX.root, "signin-stubs", "claude");

const app = useApp({
  prepare: () => {
    fs.rmSync(path.dirname(STUB), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(STUB), { recursive: true });
    fs.writeFileSync(STUB, `#!/bin/sh\n# fixture stub: only answers the sign-in check, a second late; any other call fails.\ncase "$1 $2" in\n  "auth status") sleep 1; echo '{"loggedIn": true, "authMethod": "claude.ai"}';;\n  *) exit 1;;\nesac\n`, { mode: 0o755 });
    const cfgFile = path.join(FX.claude, "agenticos.json");
    const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8")) as Record<string, any>;
    Object.assign(cfg, { provider: "local", local: { engine: "ollama", url: "http://127.0.0.1:9" } });
    cfg.claude = { ...cfg.claude, bin: STUB };
    fs.writeFileSync(cfgFile, `${JSON.stringify(cfg, null, 2)}\n`);
    const stateFile = FX.v("brain/_index/provider-state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as Record<string, unknown>;
    delete state.claude;
    delete state.codex;
    Object.assign(state, { name: "none", reason: "local-down", localReason: "local-down", checkedAt: new Date().toISOString() });
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    // A Mac with no past session either: with one, Sessions would be on the rail from the start for its History
    // (install-import B11), and this would test nothing.
    fs.rmSync(path.join(FX.claude, "projects"), { recursive: true, force: true });
    fs.rmSync(path.join(FX.home, ".codex", "sessions"), { recursive: true, force: true });
    fs.rmSync(FX.v("brain/_index/session-index.json"), { force: true });
    const stamp = FX.v("brain/_index/agent-runs/.reconcile");
    fs.mkdirSync(path.dirname(stamp), { recursive: true });
    fs.writeFileSync(stamp, `${new Date().toISOString()}\n`);
  },
});

test("a fresh local install: Sessions joins the rail on the first launch once the sign-in check answers", async () => {
  const h = app();
  const { win } = h;
  await expect(rail(win, "pulse")).toHaveClass(/is-active/);
  await expect(rail(win, "chat")).toBeVisible({ timeout: 20_000 });
  const state = JSON.parse(fs.readFileSync(FX.v("brain/_index/provider-state.json"), "utf8")) as { claude?: { loggedIn?: boolean; bin?: string } };
  expect(state.claude?.loggedIn).toBe(true);
  expect(state.claude?.bin).toBe(STUB);
  // In its place, after Code, and it opens.
  const ids = await win.locator(".aos-wb-railtabs .aos-wb-railbtn").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab));
  expect(ids.slice(0, 4)).toEqual(["notifications", "pulse", "term", "chat"]);
  await expect(rail(win, "pulse")).toHaveClass(/is-active/);
  await openTab(win, "chat");
  await expect(content(win).locator(".aos-ss-list")).toBeVisible();
  expectNoErrors(h);
});
