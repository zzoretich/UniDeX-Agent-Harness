// `npm run dist:verify`, what a release build must be: the app and the DMG in dist/ are signed with a Developer ID under
// the hardened runtime, notarized and stapled, carry exactly the entitlements and fuses electron-builder.yml asks for,
// and ship nothing they should not (source maps, other platforms' prebuilds, a home folder's path). Phase 4: the release
// refuses to start with a debugging switch, so nothing can drive it from outside (src/main/policy/debug.ts). Phase 5: the
// bundle carries the runtime (Resources/payload) at the app's version, with its dependencies and without tests, npm's
// .bin links or a home path, and its CLI loads; a full build knows its update feed (app-update.yml) and has the zip and
// latest-mac.yml the updater reads. Agent computer D18: the peer addon ships unpacked beside node-pty, signed like it,
// and nothing else of native/ ships.
//
//   node scripts/verify-dist.mjs [--notarize-dmg] [--app-only]
//
// electron-builder notarizes and staples only the app. --notarize-dmg first sends the DMG to Apple's notary service
// and staples its ticket, with the notarytool keychain profile named in APPLE_KEYCHAIN_PROFILE. --app-only skips the
// DMG (a `--dir` build).

import { extractFile, listPackage } from "@electron/asar";
import { FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
const APP_ID = "com.zzoretich.agenticos-workbench";
const NAME = pkg.productName; // UniDeX (spec D2)
const APP = path.join(repo, "dist", "mac-arm64", `${NAME}.app`);
const DMG = path.join(repo, "dist", `AgenticOS-Workbench-${pkg.version}-arm64.dmg`);
const RES = path.join(APP, "Contents", "Resources");
const PTY = path.join(RES, "app.asar.unpacked", "node_modules", "node-pty", "prebuilds", "darwin-arm64");
const PEER = path.join(RES, "app.asar.unpacked", "native", "peer", "build", "Release", "peer.node");
const ENTITLEMENTS = ["com.apple.security.automation.apple-events", "com.apple.security.cs.allow-jit"];
const ON = 49;
const OFF = 48;
const FUSES = {
  RunAsNode: OFF,
  EnableCookieEncryption: ON,
  EnableNodeOptionsEnvironmentVariable: OFF,
  EnableNodeCliInspectArguments: OFF,
  EnableEmbeddedAsarIntegrityValidation: ON,
  OnlyLoadAppFromAsar: ON,
  LoadBrowserProcessSpecificV8Snapshot: OFF,
  GrantFileProtocolExtraPrivileges: OFF,
};
// Electron 44's ninth fuse, which @electron/fuses 1.8 has no name for: WasmTrapHandlers, left at its default (on).
const WASM_TRAP_HANDLERS = 8;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const run = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, stdout: r.stdout ?? "", out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
/** A property list (a file, or XML text) as JSON. */
const plist = (file, text) => JSON.parse(run("plutil", ["-convert", "json", "-o", "-", text === undefined ? file : "-"], text).stdout);
const firstLine = (s) => s.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";
/** The signing facts codesign reports for one file or bundle. */
function signature(target) {
  const out = run("codesign", ["-dv", "--verbose=4", target]).out;
  return {
    identifier: /^Identifier=(.*)$/m.exec(out)?.[1],
    team: /^TeamIdentifier=(.*)$/m.exec(out)?.[1],
    runtime: /flags=0x[0-9a-f]+\([^)]*runtime[^)]*\)/.test(out),
    developerId: /^Authority=Developer ID Application: /m.test(out),
    timestamp: /^Timestamp=/m.test(out),
    cdhash: /^CDHash=(.*)$/m.exec(out)?.[1],
  };
}

if (!fs.existsSync(APP)) { console.error(`no app at ${APP}: run \`npm run dist\``); process.exit(2); }

// ── notarize the DMG (optional) ──────────────────────────────────────

if (argv.includes("--notarize-dmg")) {
  const profile = process.env.APPLE_KEYCHAIN_PROFILE;
  if (!profile) { console.error("--notarize-dmg needs APPLE_KEYCHAIN_PROFILE (a notarytool keychain profile)"); process.exit(2); }
  console.log(`notarizing ${path.basename(DMG)} (this waits for Apple)…`);
  const sub = run("xcrun", ["notarytool", "submit", DMG, "--keychain-profile", profile, "--wait"]);
  // notarytool prints "status: In Progress" while it waits; the last status line is Apple's verdict.
  const status = [...sub.out.matchAll(/status: ([A-Za-z ]+)/g)].pop()?.[1]?.trim();
  check("Apple accepts the DMG", sub.code === 0 && status === "Accepted", status ?? firstLine(sub.out));
  const staple = run("xcrun", ["stapler", "staple", DMG]);
  check("its ticket is stapled", staple.code === 0, firstLine(staple.out));
}

// ── the app's identity ───────────────────────────────────────────────

const info = plist(path.join(APP, "Contents", "Info.plist"));
check("bundle id", info.CFBundleIdentifier === APP_ID, info.CFBundleIdentifier);
check("name", info.CFBundleName === NAME && info.CFBundleDisplayName === NAME, info.CFBundleName);
check("version", info.CFBundleShortVersionString === pkg.version, info.CFBundleShortVersionString);
const schemes = (info.CFBundleURLTypes ?? []).flatMap((t) => t.CFBundleURLSchemes ?? []);
check("claims agenticos://", schemes.length === 1 && schemes[0] === "agenticos", schemes.join(", "));

// ── signature, entitlements, fuses ───────────────────────────────────

const strict = run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", APP]);
check("codesign --verify --deep --strict", strict.code === 0, firstLine(strict.out));
const sig = signature(APP);
check("signed with a Developer ID, hardened runtime, secure timestamp", sig.developerId && sig.runtime && sig.timestamp && sig.team && sig.team !== "not set", `team ${sig.team}`);
const ents = plist(null, run("codesign", ["-d", "--entitlements", "-", "--xml", APP]).stdout);
const entKeys = Object.keys(ents).sort();
check("entitlements are exactly allow-jit and apple-events", JSON.stringify(entKeys) === JSON.stringify(ENTITLEMENTS) && entKeys.every((k) => ents[k] === true), entKeys.join(", "));
for (const bin of ["pty.node", "spawn-helper"]) {
  const s = signature(path.join(PTY, bin));
  check(`node-pty's ${bin} is signed by the same team, hardened`, s.team === sig.team && s.runtime, `${s.identifier} team ${s.team}`);
}
check("spawn-helper is executable", (fs.statSync(path.join(PTY, "spawn-helper")).mode & 0o111) === 0o111);
const peer = fs.existsSync(PEER) ? signature(PEER) : null;
check("the peer addon is unpacked and signed by the same team, hardened", peer && peer.team === sig.team && peer.runtime, peer ? `${peer.identifier} team ${peer.team}` : `missing: ${PEER}`);

const wire = await getCurrentFuseWire(APP);
for (const [name, want] of Object.entries(FUSES)) {
  const got = wire[FuseV1Options[name]];
  check(`fuse ${name} ${want === ON ? "on" : "off"}`, got === want, got === ON ? "on" : got === OFF ? "off" : String(got));
}
check("fuse WasmTrapHandlers on (Electron's default)", wire[WASM_TRAP_HANDLERS] === ON);

// ── what the archive holds ───────────────────────────────────────────

const asar = path.join(RES, "app.asar");
const files = listPackage(asar, { isPack: false }).map((f) => f.replace(/\\/g, "/"));
const outFiles = files.filter((f) => f.startsWith("/out/") && /\.[a-z0-9]+$/.test(f)).sort();
const FONTS = ["inter", "jetbrains-mono"].flatMap((stem) => [
  `/out/renderer/fonts/${stem}-OFL.txt`, `/out/renderer/fonts/${stem}-latin-ext-wght-normal.woff2`, `/out/renderer/fonts/${stem}-latin-wght-normal.woff2`]);
const TRAY = ["", "@2x"].map((scale) => `/out/main/trayTemplate${scale}.png`);
const expectedOut = ["/out/main/index.js", ...TRAY, "/out/preload/index.js", "/out/renderer/base.css", "/out/renderer/host.css", "/out/renderer/hud.css",
  "/out/renderer/hud.js", "/out/renderer/index.html", ...FONTS].sort();
check("out/ holds the app and nothing else", JSON.stringify(outFiles) === JSON.stringify(expectedOut), outFiles.join(" "));
check("no source maps", !files.some((f) => f.endsWith(".map")));
// The archive lists the addon (its bytes are unpacked) and the folders above it, and nothing else of native/.
const PEER_ENTRY = "/native/peer/build/Release/peer.node";
const peerEntries = new Set(["/native", "/native/peer", "/native/peer/build", "/native/peer/build/Release", PEER_ENTRY]);
const nativeStray = files.filter((f) => (f === "/native" || f.startsWith("/native/")) && !peerEntries.has(f));
check("native/ ships the peer addon and nothing else", files.includes(PEER_ENTRY) && nativeStray.length === 0, nativeStray.join(" "));
check("only this Mac's node-pty prebuild", !files.some((f) => /prebuilds\/(darwin-x64|win32)/.test(f)) && fs.readdirSync(path.dirname(PTY)).join() === "darwin-arm64");
const home = os.homedir();
const leaks = expectedOut.filter((f) => extractFile(asar, f.slice(1)).toString("utf8").includes(home));
if (fs.existsSync(PEER) && fs.readFileSync(PEER).includes(home)) leaks.push(PEER_ENTRY);
check("no home-folder path in the bundled code or the peer addon", leaks.length === 0, leaks.join(", "));

// ── the opener every session's BROWSER points at (session-browser S23) ─

const OPENER = path.join(RES, "opener", "unidex-open.js");
check("the opener is packaged and executable", fs.existsSync(OPENER) && (fs.statSync(OPENER).mode & 0o111) === 0o111, OPENER);

// ── the runtime it carries, and its update feed (phase 5) ────────────

const PAYLOAD = path.join(RES, "payload");
let manifest = null;
try { manifest = JSON.parse(fs.readFileSync(path.join(PAYLOAD, "payload.json"), "utf8")); } catch { /* none */ }
check("the payload is this version's release tree, with its dependencies", manifest?.schema === 1 && manifest.version === pkg.version && manifest.runtimeDeps === true
  && ["cli/aos.js", "brain/scripts/package.json", "vault-template", ".claude-plugin/marketplace.json", "plugin/bin/aos", "codex-plugin",
    "brain/scripts/node_modules/@modelcontextprotocol/sdk/package.json"].every((f) => fs.existsSync(path.join(PAYLOAD, f))),
  manifest ? `${manifest.version} · deps ${manifest.runtimeDeps}` : "no payload.json");
const payloadFiles = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); payloadFiles.push({ p, e }); if (e.isDirectory()) walk(p); } };
if (manifest) walk(PAYLOAD);
const rel = (p) => path.relative(PAYLOAD, p);
const stray = payloadFiles.filter(({ p, e }) => e.isSymbolicLink() || /(^|\/)(\.bin|test|fixtures|rehearsal)$/.test(rel(p)) && e.isDirectory() && !rel(p).includes("node_modules/") || /\.test\.js$/.test(p) && !rel(p).includes("node_modules/"));
check("the payload has no tests, fixtures or symlinks", stray.length === 0, stray.slice(0, 5).map(({ p }) => rel(p)).join(", "));
const homeHits = payloadFiles.filter(({ p, e }) => e.isFile() && !rel(p).includes("node_modules/") && fs.statSync(p).size < 1024 * 1024 && fs.readFileSync(p, "utf8").includes(home));
check("no home-folder path in the payload", homeHits.length === 0, homeHits.slice(0, 5).map(({ p }) => rel(p)).join(", "));
const cliLoads = run(process.execPath, ["-e", `require(${JSON.stringify(path.join(PAYLOAD, "cli", "aos.js"))}); require(${JSON.stringify(path.join(PAYLOAD, "brain", "scripts", "node_modules", "@modelcontextprotocol", "sdk", "package.json"))})`]);
check("the payload's CLI and runtime dependencies load", cliLoads.code === 0, firstLine(cliLoads.out));

// ── no way in from outside ───────────────────────────────────────────

/** A port nothing listens on now. */
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once("error", reject);
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
/** Whether something accepts a connection on the port. */
const listening = (port) => new Promise((resolve) => {
  const sock = net.connect(port, "127.0.0.1");
  sock.once("connect", () => { sock.destroy(); resolve(true); });
  sock.once("error", () => resolve(false));
});

{
  const port = await freePort();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "aos-verify-"));
  const exe = path.join(APP, "Contents", "MacOS", NAME);
  const child = spawn(exe, [`--remote-debugging-port=${port}`], { env: { ...process.env, AOS_APP_USER_DATA: userData }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => { stderr += d; });
  let opened = false;
  const exit = await new Promise((resolve) => {
    const poll = setInterval(async () => { if (await listening(port)) opened = true; }, 100);
    const timer = setTimeout(() => { clearInterval(poll); child.kill("SIGKILL"); resolve(null); }, 15_000);
    child.once("exit", (code) => { clearInterval(poll); clearTimeout(timer); resolve(code); });
  });
  check("a release build refuses --remote-debugging-port: it exits before anything listens", exit === 1 && !opened && /refusing to start/.test(stderr),
    `exit ${exit}${opened ? ", the port answered" : ""}; ${firstLine(stderr)}`);
  fs.rmSync(userData, { recursive: true, force: true });
}

// ── Gatekeeper and the ticket ────────────────────────────────────────

const gk = run("spctl", ["--assess", "--type", "execute", "-vv", APP]);
check("Gatekeeper accepts the app as notarized", gk.code === 0 && /source=Notarized Developer ID/.test(gk.out), gk.out.match(/source=.*/)?.[0] ?? firstLine(gk.out));
const st = run("xcrun", ["stapler", "validate", APP]);
check("the app's ticket is stapled", st.code === 0, firstLine(st.out));

// ── the DMG ──────────────────────────────────────────────────────────

if (!argv.includes("--app-only")) {
  // The updater's files (I6): the app's own feed (electron-builder writes app-update.yml only when it builds a DMG or a
  // zip, so a --dir build has none), the zip Squirrel installs from and the feed that names it.
  const feed = fs.existsSync(path.join(RES, "app-update.yml")) ? fs.readFileSync(path.join(RES, "app-update.yml"), "utf8") : "";
  check("the app knows its update feed (GitHub Releases of this repo)", /provider: github/.test(feed) && /owner: zzoretich/.test(feed) && /repo: UniDeX-Agent-Harness/.test(feed), feed.replace(/\n/g, " ").trim());
  const ZIP = path.join(repo, "dist", `AgenticOS-Workbench-${pkg.version}-arm64.zip`);
  const latest = path.join(repo, "dist", "latest-mac.yml");
  const yml = fs.existsSync(latest) ? fs.readFileSync(latest, "utf8") : "";
  check("the update zip and latest-mac.yml are built, for this version", fs.existsSync(ZIP) && new RegExp(`^version: ${pkg.version.replace(/\./g, "\\.")}$`, "m").test(yml) && yml.includes(path.basename(ZIP)),
    `${path.basename(ZIP)}${fs.existsSync(ZIP) ? "" : " missing"} · ${yml.split("\n")[0] ?? ""}`);
  if (!fs.existsSync(DMG)) check("the DMG exists", false, DMG);
  else {
    const dsig = run("codesign", ["--verify", "--verbose=2", DMG]);
    check("the DMG is signed", dsig.code === 0 && signature(DMG).team === sig.team, firstLine(dsig.out));
    const dst = run("xcrun", ["stapler", "validate", DMG]);
    check("the DMG's ticket is stapled", dst.code === 0, firstLine(dst.out));
    const dgk = run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "-vv", DMG]);
    check("Gatekeeper accepts the DMG as notarized", dgk.code === 0 && /source=Notarized Developer ID/.test(dgk.out), dgk.out.match(/source=.*/)?.[0] ?? firstLine(dgk.out));
    // The app inside is the one checked above.
    const mnt = fs.mkdtempSync(path.join(os.tmpdir(), "aos-dmg-"));
    const at = run("hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mnt, DMG]);
    if (at.code !== 0) check("the DMG mounts", false, firstLine(at.out));
    else {
      try {
        const inner = path.join(mnt, `${NAME}.app`);
        const same = fs.existsSync(inner) && signature(inner).cdhash === sig.cdhash;
        check("the DMG holds this app (same code directory hash)", same);
        check("the DMG offers the Applications folder", fs.existsSync(path.join(mnt, "Applications")));
      } finally { run("hdiutil", ["detach", mnt, "-quiet"]); fs.rmSync(mnt, { recursive: true, force: true }); }
    }
  }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
