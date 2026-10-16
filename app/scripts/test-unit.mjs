// Unit tests: bundles each tests/unit/*.test.ts with esbuild (TypeScript, the .cjs guards and the HUD's modules
// all resolve the way the app build resolves them) and runs the bundles with node --test.

import * as esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "tests/unit");
const out = path.join(root, "out-test");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const entries = readdirSync(dir).filter((f) => f.endsWith(".test.ts")).map((f) => path.join(dir, f));
await esbuild.build({
  entryPoints: entries,
  outdir: out,
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  // HUD modules imported from ../obsidian-plugin resolve their packages from the app's node_modules (scripts/build.mjs).
  nodePaths: [path.join(root, "node_modules")],
  plugins: [{
    name: "electron-stub",
    setup(build) { build.onResolve({ filter: /^electron$/ }, () => ({ path: path.join(dir, "electron-stub.cjs") })); },
  }],
  logLevel: "warning",
});

const files = readdirSync(out).filter((f) => f.endsWith(".cjs")).map((f) => path.join(out, f));
// The repository's test environment, as every other suite runs with (tools/test-env.js): the host variables cleared,
// and the runtime the tests spawn lets them resolve their temp vaults (brain/scripts/lib/test-guard.js refuses a test run
// without it).
const r = spawnSync(process.execPath, ["--require", path.join(root, "..", "tools", "test-env.js"), "--test", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
