// UniDeX 2.0, PR 2 (spec 2026-10-14-local-first A2, A3, A17): background work and Vault chat on the local engine. The
// fixture runs provider local with the local engine down (nothing answers at local.url) and Claude Code signed in:
// Sessions stays on the rail (it follows the hosts, not the background provider); Vault chat starts on This Mac, says
// the model is down, and a question that comes back down offers "Run once on Claude Code" with the reasoner's cap,
// which runs only when clicked; Settings ▸ Local engine says what the engine is doing.

import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { CLAUDE_ANSWER, FX, claudeCalls, content, expectNoErrors, installChatStubs, openTab, rail, useApp } from "./harness";

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
  env: { AOS_APP_WRITE: "chat" },
  prepare: () => {
    installChatStubs();
    const file = path.join(FX.claude, "agenticos.json");
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    // Provider local, the engine nowhere to be found (port 9 refuses at once), Claude Code the one host.
    Object.assign(j, { provider: "local", local: { engine: "ollama", url: "http://127.0.0.1:9" } });
    fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
    localDown();
  },
});

test("Sessions stays on the rail with the local engine down while Claude Code is signed in (A17)", async () => {
  const h = app();
  await expect(rail(h.win, "chat")).toBeVisible();
  await openTab(h.win, "chat");
  await expect(content(h.win).locator(".aos-asst-head .aos-title")).toHaveText("Vault");
  expectNoErrors(h);
});

test("Vault chat starts on This Mac and says the local model is down; the chip still offers Claude Code (A2, A3)", async () => {
  const { win } = app();
  await openTab(win, "chat");
  const chip = content(win).locator('.aos-asst-tools .aos-hm[data-mode="vault"] .aos-hm-trigger');
  await expect(chip.locator(".aos-hm-chiphost")).toHaveText("This Mac");
  await expect(chip).toHaveAttribute("data-host", "local");
  await expect(content(win).locator(".aos-asst-mode")).toHaveText(" · This Mac (the local model, no spend)");
  await expect(content(win).locator(".aos-asst-localdown")).toHaveText("The local model is not answering: start Ollama (or your local engine).");
  await chip.click();
  await expect(content(win).locator('.aos-hm-pop .aos-hm-host[data-host="local"]')).toHaveAttribute("aria-pressed", "true");
  await expect(content(win).locator('.aos-hm-pop .aos-hm-host[data-host="claude"]')).toBeEnabled();
  await win.keyboard.press("Escape");
});

test("a question with the local model down comes back down, offers Run once on Claude Code with its cap, and only a click runs it", async () => {
  const { win } = app();
  await openTab(win, "chat");
  const before = claudeCalls().length;
  await content(win).locator("textarea.aos-asst-input").fill("What is due this week?");
  await content(win).locator(".aos-asst-actions button", { hasText: "Send (⌘↵)" }).click();
  const err = content(win).locator(".aos-asst-turn-assistant:not(.aos-asst-live) .aos-text-rose").last();
  await expect(err).toContainText("the local model cannot answer (local-down)", { timeout: 30_000 });
  expect(claudeCalls().length).toBe(before);
  const once = content(win).locator('.aos-asst-runonce button[data-host="claude"]');
  await expect(once).toHaveText(/^Run once on Claude Code \(reasoner cap: (today \$[\d.]+ of )?\$5\)$/);
  await once.click();
  await expect(content(win).locator(".aos-asst-turn-assistant:not(.aos-asst-live) .aos-asst-body").last()).toContainText(CLAUDE_ANSWER.text.slice(0, 20), { timeout: 30_000 });
  const calls = claudeCalls().slice(before);
  expect(calls.length).toBe(1);
  expect(calls[0].argv[0]).toBe("-p");
  // Once means once: the chip is still on This Mac.
  await expect(content(win).locator('.aos-asst-tools .aos-hm[data-mode="vault"] .aos-hm-chiphost')).toHaveText("This Mac");
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
