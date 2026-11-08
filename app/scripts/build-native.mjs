// Builds the app's own native addon, native/peer (agent-computer D18): the peer-credential and code-signature checks the
// agent bridge admits a connection with. The postinstall runs it after fix-pty.mjs, with the node-gyp pinned in
// devDependencies; it needs the Xcode command-line tools and python3. The app is macOS-only: elsewhere this says so and
// builds nothing. A failed build fails the install, so a checkout never runs without the addon.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.platform !== "darwin") {
  console.log(`build-native: skipped native/peer (the app is macOS-only; this is ${process.platform})`);
  process.exit(0);
}

const gyp = path.join(root, "node_modules", "node-gyp", "bin", "node-gyp.js");
const r = spawnSync(process.execPath, [gyp, "rebuild"], { cwd: path.join(root, "native", "peer"), stdio: "inherit" });
if (r.status !== 0) {
  console.error(`build-native: native/peer failed to build (${r.error?.message ?? `node-gyp exited ${r.status ?? r.signal}`}); it needs the Xcode command-line tools and python3`);
  process.exit(1);
}
