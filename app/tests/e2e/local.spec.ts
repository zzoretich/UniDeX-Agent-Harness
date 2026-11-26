// UniDeX 2.0, PR 2 (spec 2026-10-14-local-first A8, A13, A18): background work on the local engine. The fixture runs
// provider local with the local engine down (nothing answers at local.url) and Claude Code signed in; Settings ▸ Local
// engine says what the engine is doing. (Vault chat's cases went with it, remove-sessions D1.)

import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, content, openTab, useApp } from "./harness";

/** What the runtime publishes under provider local with the engine down: no provider, its reason, and the hosts' logins
 *  (reconcile-sessions keeps them fresh under provider local). */
function localDown(): void {
  const file = FX.v("brain/_index/provider-state.json");
  const at = new Date().toISOString();
  const j = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  const claude = (j.claude as Record<string, unknown> | undefined) ?? {};
  Object.assign(j, {
    name: "none", reason: "local-down", localReason: "local-down", checkedAt: at,
    claude: { ...claude, loggedIn: true, checkedAt: at },
    local: { engine: "ollama", url: "http://127.0.0.1:9", reachable: false, models: [], checkedAt: at },
  });
  delete j.model;
  fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
}

const app = useApp({
  prepare: () => {
    const file = path.join(FX.claude, "agenticos.json");
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    // Provider local, the engine nowhere to be found (port 9 refuses at once), Claude Code the one host.
    Object.assign(j, { provider: "local", local: { engine: "ollama", url: "http://127.0.0.1:9" } });
    fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
    localDown();
  },
});

test("Settings ▸ Local engine: the engine, its state, the model, the embedder and today's calls; Pull the model (A8, A13, A18)", async () => {
  const { win } = app();
  await openTab(win, "settings");
  const box = content(win).locator('[data-tour="settings-local"]');
  await expect(box).toHaveAttribute("data-state", "down");
  await expect(box).toHaveAttribute("data-active", "true");
  await expect(box.locator(".aos-st-localstate")).toContainText("Ollama is not answering at http://127.0.0.1:9");
  await expect(box.locator('[data-row="engine"] .aos-st-localvalue')).toHaveText("Ollama at http://127.0.0.1:9");
  await expect(box.locator('[data-row="embedder"] .aos-st-localvalue')).toHaveText(/^qwen3-embedding:0\.6b/);
  await expect(box.locator('[data-row="today"] .aos-st-localvalue')).toHaveText(/local calls? today/);
  await expect(box.locator('[data-act="local-pull"]')).toHaveText("Pull the model");
  await expect(box.locator('[data-act="local-status"]')).toHaveText("❯_ aos local");
  // The ai.* switches are rows of their own in the provider section.
  await expect(content(win).locator(".aos-st-row .aos-st-key", { hasText: /^ai\.chat$/ })).toHaveCount(1);
});
