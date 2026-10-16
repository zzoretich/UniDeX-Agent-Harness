// `npm run smoke:packaged`: runs the packaged app and checks what only a packaged build can get wrong. It starts from its archive with
// the fuses on; every tab draws without an error; node-pty loads from app.asar.unpacked and a shell runs in the Term
// tab; the tray popover draws with its styles; and quitting leaves no process behind. The page comes from app://hud
// (src/main/app-scheme.ts), which main reads out of app.asar, and runs sandboxed (phase 4). Phase 5: the bundle carries
// the runtime (Resources/payload) at the app's version, updates stay off in the smoke build, and with no install the
// app opens the first-run wizard on that payload. 2.0: the fixture is an install from before 2.0 (its agenticos.json
// says 1.8.0), so its first attach meets the launch sequence (tour C11): the runtime update, which runs `aos upgrade`
// from the bundle's own payload (the e2e suite's is a stand-in), then Go local, Import, What's new and Getting started,
// each once; the smoke dismisses each without acting (launch.spec.ts drives their buttons).
//
//   node scripts/smoke-packaged.mjs [--app <path>] [--live] [--work <dir>] [--keep]
//
// Default: a fresh synthetic install (scripts/make-fixture-vault.mjs) in a temp folder, with the app started
// directly in that install's environment. A command typed into the Term tab must come back computed by the shell.
// --live: the vault named in ~/.claude/agenticos.json, with a userData of its own, started through
// LaunchServices (`open`) as Finder starts it. Nothing is typed there: its shell is the user's own.
//
// The fuses switch off --inspect, so Playwright's _electron cannot drive a packaged build. The smoke connects to the
// renderer over the DevTools protocol (--remote-debugging-port) instead, the same page the e2e suite drives. A release
// build refuses that switch (phase 4, S8; `npm run dist:verify` checks it does), so the smoke drives the smoke build:
// `npm run dist:test` packages the same sources the same way (archive, fuses, unpacked node-pty, ad-hoc signed) into
// dist-test/, with the one difference that it accepts the switch. It quits the app with SIGTERM, which Electron handles
// as app.quit(), the path ⌘Q takes.

import { chromium } from "playwright";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const APP = path.resolve(flag("--app", path.join(repo, "dist-test", "mac-arm64", `${JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).productName}.app`)));
const LIVE = argv.includes("--live");
const KEEP = argv.includes("--keep");
const EXE = path.join(APP, "Contents", "MacOS", path.basename(APP, ".app"));
const VERSION = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version;
const TABS = ["pulse", "files", "todo", "proposals", "notifications", "spaces", "memory", "runs", "routines", "skills", "agents", "agent-teams", "chat", "term", "settings"];

if (!fs.existsSync(EXE)) { console.error(`no packaged app at ${APP}: run \`npm run dist:test\``); process.exit(2); }

const work = fs.mkdtempSync(path.join(path.resolve(flag("--work", os.tmpdir())), "aos-smoke-"));
const userData = path.join(work, "userData");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeoutMs, stepMs = 250) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* not yet */ }
    if (Date.now() > end) return null;
    await sleep(stepMs);
  }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function processTable() {
  return execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n").filter(Boolean).map((l) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    return m ? { pid: Number(m[1]), ppid: Number(m[2]), command: m[3] } : null;
  }).filter(Boolean);
}
function descendants(root) {
  const table = processTable();
  const out = [];
  const walk = (pid) => { for (const p of table) if (p.ppid === pid) { out.push(p); walk(p.pid); } };
  walk(root);
  return out;
}
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

// ── start ────────────────────────────────────────────────────────────

const port = await freePort();
const appArgs = [`--remote-debugging-port=${port}`];
let mainPid = null;
let stderr = "";
let vault = null;
let aosConfig = null;
let t0 = Date.now();
if (LIVE) {
  execFileSync("open", ["-n", "-a", APP, "--env", `AOS_APP_USER_DATA=${userData}`, "--args", ...appArgs]);
  mainPid = (await until(() => processTable().find((p) => p.command.startsWith(EXE) && p.command.includes(appArgs[0]))?.pid, 20_000)) ?? null;
} else {
  const fx = path.join(work, "fixture");
  const g0 = Date.now();
  execFileSync(process.execPath, [path.join(repo, "scripts", "make-fixture-vault.mjs"), "--out", fx, "--quiet"], { stdio: "inherit" });
  console.log(`fixture: ${((Date.now() - g0) / 1000).toFixed(1)} s`);
  const env = JSON.parse(fs.readFileSync(path.join(fx, "env.json"), "utf8"));
  // As the e2e harness does: an app started from Finder has no AOS_HEADLESS, and under it the runtime refreshes the app
  // starts would do nothing. userData is set explicitly, so CFFIXED_USER_HOME goes too: with it, the keychain the
  // cookie-encryption fuse reaches would be looked for in the fake home.
  delete env.AOS_HEADLESS;
  delete env.CFFIXED_USER_HOME;
  vault = path.join(fx, "vault");
  Object.assign(env, { AOS_APP_VAULT: vault, AOS_APP_USER_DATA: userData });
  // An install from before 2.0 (launch.spec.ts's): the app's runtime update is due, and the upgrade then leaves Go local
  // and Import pending for the launch sequence.
  aosConfig = env.AOS_CONFIG;
  const cfg = JSON.parse(fs.readFileSync(aosConfig, "utf8"));
  fs.writeFileSync(aosConfig, `${JSON.stringify({ ...cfg, version: "1.8.0" }, null, 2)}\n`);
  fs.rmSync(path.join(vault, "brain", "_index", "migrations.json"), { force: true });
  t0 = Date.now();
  const child = spawn(EXE, appArgs, { env, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => { stderr += d; });
  mainPid = child.pid ?? null;
}
check("the app starts", mainPid && alive(mainPid), mainPid ? `pid ${mainPid}` : "no process");
if (!mainPid) process.exit(1);

// ── connect ──────────────────────────────────────────────────────────

const browser = await until(() => chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2_000 }), 30_000, 500);
check("the renderer answers over the DevTools protocol", browser);
if (!browser) { process.kill(mainPid, "SIGKILL"); process.exit(1); }
const ctx = browser.contexts()[0];
const page = await until(() => ctx.pages().find((p) => p.url() === "app://hud/index.html"), 20_000);
check("the main window loads the app's page", page, page?.url() ?? "none");
if (!page) { process.kill(mainPid, "SIGKILL"); process.exit(1); }

const errors = [];
page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`[renderer] ${m.text()}`); });

const booted = await until(() => page.locator(".aos-wb-railbtn").count(), 30_000);
check("the Workbench draws", booted, `${((Date.now() - t0) / 1000).toFixed(1)} s after launch`);
const info = await page.evaluate(() => {
  const h = window.aosHost;
  const sheets = [...document.styleSheets].filter((s) => s.href).map((s) => { try { return s.cssRules.length; } catch { return -1; } });
  return {
    info: h?.info, resourcesPath: h?.info?.resourcesPath, sheets,
    // What the status bar shows: the write-mode item is in the DOM but hidden (display: none) by default.
    status: document.querySelector(".aos-host-status")?.innerText?.trim() ?? "",
  };
});
check("it reports the package's version", info.info?.appVersion === VERSION, info.info?.appVersion);
check("it keeps its data in its own folder", info.info?.userData === userData, info.info?.userData);
check("it attaches to the expected vault", LIVE ? !!info.info?.vaultRoot : info.info?.vaultRoot === vault, info.info?.vaultRoot ?? "none");
check("its resources are the bundle's", info.resourcesPath === path.join(APP, "Contents", "Resources"), info.resourcesPath);
// Phase 5: the runtime the wizard installs from, and the updater, which the ad-hoc-signed smoke build never runs.
let payload = null;
try { payload = JSON.parse(fs.readFileSync(path.join(APP, "Contents", "Resources", "payload", "payload.json"), "utf8")); } catch { /* none */ }
check("the bundle carries the runtime at the app's version, with its dependencies", payload?.version === VERSION && payload?.runtimeDeps === true
  && fs.existsSync(path.join(APP, "Contents", "Resources", "payload", "brain", "scripts", "node_modules", "@modelcontextprotocol", "sdk", "package.json")),
  payload ? `${payload.version}${payload.commit ? ` (${String(payload.commit).slice(0, 7)})` : ""}` : "no payload.json");
check("updates are off in the smoke build", info.info?.update?.status === "off" && info.info?.update?.reason === "the smoke build", JSON.stringify(info.info?.update));
check("attach mode knows the vault", !!info.info?.attach && (LIVE || info.info.attach.behind === true), JSON.stringify(info.info?.attach));

// ── the launch sequence (tour C11): a fresh data folder on an install from before 2.0 ──────

const shown = (sel, ms = 20_000) => until(async () => (await page.locator(sel).count()) > 0, ms);
const launchLog = () => page.evaluate(() => [...(window.aosHost.launchLog ?? [])]);
if (LIVE) {
  // The user's own vault: whatever it is due, closed untouched (Esc dismisses each; nothing is updated or applied).
  for (let i = 0; i < 6 && (await shown(".modal-container", 3_000)); i++) { await page.keyboard.press("Escape"); await sleep(500); }
} else {
  const runtime = await shown(".aos-runtime-modal");
  check("a first attach opens the launch sequence with the runtime update", runtime && JSON.stringify(await launchLog()) === '["runtime"]', JSON.stringify(await launchLog()));
  if (runtime) {
    await page.locator(".aos-runtime-modal .aos-runtime-go").click();
    const status = () => page.locator(".aos-runtime-modal .aos-setup-status").textContent();
    const updated = await until(async () => /^Updated to |stopped/.test((await status()) ?? "") && (await status()), 180_000, 500);
    let version = null;
    try { version = JSON.parse(fs.readFileSync(aosConfig, "utf8")).version; } catch { /* unread */ }
    check("Update now runs aos upgrade from the bundle's payload", updated === `Updated to ${VERSION}.` && version === VERSION, `${updated ?? "no answer"} · agenticos.json ${version}`);
    await page.locator(".aos-runtime-modal button", { hasText: "Close" }).click();
  }
  // Then each card once, in order, each dismissed (a dismissed card is remembered and never opens on its own again).
  for (const [step, sel, close] of [["go-local", ".modal.aos-golocal-modal", null], ["import", ".modal.aos-importsheet-modal", null], ["whats-new", ".modal.aos-whatsnew-modal", ".aos-whatsnew-ok"]]) {
    const up = await shown(sel, 30_000);
    const log = await launchLog();
    check(`then ${step}`, up && log[log.length - 1] === step, JSON.stringify(log));
    if (!up) break;
    if (close) await page.locator(`${sel} ${close}`).click(); else await page.keyboard.press("Escape");
    await until(async () => (await page.locator(sel).count()) === 0, 10_000);
  }
  const ended = await until(async () => (await launchLog()).includes("checklist") && (await page.locator(".modal-container").count()) === 0, 10_000);
  check("Getting started ends it, each step once, and no dialog is left over the Workbench", ended
    && JSON.stringify(await launchLog()) === JSON.stringify(["runtime", "go-local", "import", "whats-new", "checklist"]), JSON.stringify(await launchLog()));
}
check("its three linked stylesheets load from app://hud", info.sheets.length === 3 && info.sheets.every((n) => n > 0), JSON.stringify(info.sheets));
// The app is the Workbench (phase 1, D6): with no AOS_APP_WRITE every verified surface writes, and the status bar item
// that names a narrowed run (READ-ONLY, or WRITES: …) is hidden.
check("it writes with every verified surface by default (no READ-ONLY)",
  info.info?.writeSource === "default" && (info.info?.writeSurfaces?.length ?? 0) > 0 && !/READ-ONLY|WRITES:/.test(info.status),
  `${info.info?.writeSource ?? "?"}: ${(info.info?.writeSurfaces ?? []).join(",") || "none"}`);

// ── every tab ────────────────────────────────────────────────────────

for (const id of TABS) {
  const btn = page.locator(`.aos-wb-railbtn[data-tab="${id}"]`);
  // Chat hides itself when no model provider is on record, as under the fixture's `none`.
  if (!(await btn.count())) { check(`tab ${id}`, id === "chat" && !LIVE, "not in the rail"); continue; }
  const before = errors.length;
  await btn.click();
  const drawn = await until(async () => (await btn.getAttribute("class"))?.includes("is-active")
    && (await page.evaluate(() => document.querySelector(".aos-wb-content")?.textContent?.trim().length ?? 0)) > 0, 10_000);
  await sleep(600);
  check(`tab ${id}`, drawn && errors.length === before, errors.slice(before).join(" | ").slice(0, 300));
}

// ── the terminal ─────────────────────────────────────────────────────

await page.locator('.aos-wb-railbtn[data-tab="term"]').click();
const sessions = await until(() => page.evaluate(() => {
  const list = window.aosHost.plugin.terminalPool.list();
  return list.length && list.every((s) => !s.isExited) ? list.map((s) => ({ id: s.id, pid: s.pty?.pid ?? null, shell: s.shell })) : null;
}), 15_000);
check("node-pty starts a shell (spawn-helper from app.asar.unpacked)", sessions, sessions ? sessions.map((s) => `${s.shell} pid ${s.pid}`).join(", ") : "no live session");
// node-pty runs in main (phase 4): the native module main has mapped is the one unpacked beside the archive.
const loadedFrom = execFileSync("lsof", ["-Fn", "-p", String(mainPid)], { encoding: "utf8" }).split("\n")
  .filter((l) => l.startsWith("n") && l.includes("pty.node")).map((l) => l.slice(1).replace(/^.*\.app\/Contents\/Resources\//, ""));
check("node-pty is the bundle's", loadedFrom.length && loadedFrom.every((k) => k.startsWith("app.asar.unpacked/")), loadedFrom.join(", "));
const scrollback = () => page.evaluate(() => window.aosHost.plugin.terminalPool.list().map((s) => s.getScrollback()).join("\n"));
if (LIVE) {
  check("the shell draws its prompt", await until(async () => (await scrollback()).trim().length > 0, 15_000));
} else {
  await until(async () => (await scrollback()).includes("fixture"), 15_000);
  await page.locator(".aos-wb-content .xterm-helper-textarea").first().focus();
  await page.keyboard.type("echo aos-smoke-$((6*7))");
  await page.keyboard.press("Enter");
  check("a command typed in the Term tab runs in the shell", await until(async () => (await scrollback()).includes("aos-smoke-42"), 15_000));
}

// ── the tray popover ─────────────────────────────────────────────────

const popover = await until(() => ctx.pages().find((p) => p.url() === "about:blank"), 10_000);
const pop = popover ? await until(() => popover.evaluate(() => {
  const leaf = document.querySelector(".aos-popover-leaf");
  const sheets = [...document.styleSheets].filter((s) => s.href).map((s) => { try { return s.cssRules.length; } catch { return -1; } });
  const text = leaf?.textContent?.trim().length ?? 0;
  return text > 0 && sheets.length === 3 && sheets.every((n) => n > 0) ? { text, sheets } : null;
}), 10_000) : null;
check("the tray popover draws the SidebarHUD with its styles", pop, pop ? `${pop.text} chars, sheets ${JSON.stringify(pop.sheets)}` : "not drawn");

// ── what the guard refused, and the errors ───────────────────────────

const guard = await page.evaluate(() => window.aosHost.guard.log.map((e) => `${e.kind} ${e.what}`));
check("the write guard refused nothing", guard.length === 0, guard.slice(0, 3).join(" | "));
check("no renderer errors", errors.length === 0, errors.slice(0, 3).join(" | "));

// ── quit ─────────────────────────────────────────────────────────────

const tree = descendants(mainPid);
const shells = (sessions ?? []).map((s) => s.pid).filter(Boolean);
process.kill(mainPid, "SIGTERM");
const exited = await until(() => !alive(mainPid), 20_000);
check("SIGTERM quits the app", exited);
const watched = [...new Set([...tree.map((p) => p.pid), ...shells])];
const gone = await until(() => watched.every((pid) => !alive(pid)) && !processTable().some((p) => p.command.startsWith(APP)), 15_000);
const left = processTable().filter((p) => watched.includes(p.pid) || p.command.startsWith(APP));
check("quitting leaves no process", gone, gone ? `${watched.length} processes ended (${shells.length} shell${shells.length === 1 ? "" : "s"})` : left.map((p) => `${p.pid} ${p.command.slice(0, 120)}`).join(" | "));
if (!exited) process.kill(mainPid, "SIGKILL");
await browser.close().catch(() => {});

const mainErrors = stderr.split("\n").filter((l) => /\[main\].*(error|refused|gone)/i.test(l));
if (!LIVE) check("no main-process errors", mainErrors.length === 0, mainErrors.slice(0, 3).join(" | "));

// ── no install: the wizard, on the bundle's payload ──────────────────

if (!LIVE) {
  const fx = path.join(work, "fixture");
  const env = JSON.parse(fs.readFileSync(path.join(fx, "env.json"), "utf8"));
  delete env.AOS_HEADLESS;
  delete env.CFFIXED_USER_HOME;
  const none = path.join(work, "no-install");
  fs.mkdirSync(path.join(none, "claude"), { recursive: true });
  // No agenticos.json where the app looks, and no vault named: a first run.
  Object.assign(env, { AOS_CONFIG: path.join(none, "claude", "agenticos.json"), CLAUDE_CONFIG_DIR: path.join(none, "claude"), AOS_APP_USER_DATA: path.join(none, "userData") });
  delete env.AOS_APP_VAULT;
  const port2 = await freePort();
  const child = spawn(EXE, [`--remote-debugging-port=${port2}`], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr2 = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => { stderr2 += d; });
  const b2 = await until(() => chromium.connectOverCDP(`http://127.0.0.1:${port2}`, { timeout: 2_000 }), 30_000, 500);
  const p2 = b2 ? await until(() => b2.contexts()[0]?.pages().find((p) => p.url() === "app://hud/index.html"), 20_000) : null;
  const wizard = p2 ? await until(() => p2.evaluate(() => {
    const sub = document.querySelector(".aos-setup-sub")?.textContent ?? "";
    const ids = [...document.querySelectorAll(".aos-setup-check")].map((r) => r.getAttribute("data-check"));
    return ids.length ? { sub, ids } : null;
  }), 30_000) : null;
  // install-import B1: the checks are the toolchain's (no Homebrew, no Python), so main parsed the pins it carries.
  const IDS = ["node", "uv", "ollama", "ollama-models", "claude", "claude-login", "codex", "codex-login"];
  check("with no install it opens the wizard on the bundle's runtime, and the checks run", wizard && wizard.sub.includes(`runtime ${VERSION}`) && wizard.ids.join() === IDS.join(),
    wizard ? `${wizard.ids.join(", ")} · ${wizard.sub}` : "no wizard");
  child.kill("SIGTERM");
  check("the wizard's app quits", await until(() => child.exitCode !== null || child.signalCode !== null, 20_000));
  await b2?.close().catch(() => {});
  const wizardErrors = stderr2.split("\n").filter((l) => /\[main\].*(error|refused|gone)/i.test(l));
  check("no main-process errors in the wizard", wizardErrors.length === 0, wizardErrors.slice(0, 3).join(" | "));
}

const failed = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(work, "report.json"), `${JSON.stringify({ app: APP, live: LIVE, results, errors, guard, tree: tree.map((p) => p.command.slice(0, 200)) }, null, 2)}\n`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${LIVE ? " (live vault)" : " (fixture)"}`);
if (KEEP || failed.length) console.log(`kept: ${work}`);
else fs.rmSync(work, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
