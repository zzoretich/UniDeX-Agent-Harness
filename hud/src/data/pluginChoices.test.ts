import { test } from "node:test";
import assert from "node:assert/strict";
import { pluginChoices, pluginStep, parseShells, tildify, POLL_MS } from "./pluginChoices";
import type { PluginChoiceEnv } from "./pluginChoices";

const ENV: PluginChoiceEnv = {
  vaultBase: "/h/vault", agenticosVault: "/h/other-vault", envConfigDir: null, agenticosConfigDir: "/h/.claude", defaultConfigDir: "/h/.claude",
  home: "/h", nodeCandidates: ["/opt/node/bin/node", "/h/.nvm/node", "/usr/local/bin/node"], exists: (p) => p !== "/h/.nvm/node",
  shells: ["/bin/zsh", "/bin/bash"], envShell: "/bin/zsh",
};
const values = (key: string, current: string | number, env = ENV) => pluginChoices(key, current, env)!.map((o) => o.value);
const labels = (key: string, current: string | number, env = ENV) => pluginChoices(key, current, env)!.map((o) => o.label);

test("number rows: presets with units; a custom value is kept and marked", () => {
  assert.deepEqual(values("liveTailPollMs", 300), POLL_MS);
  assert.equal(labels("liveTailPollMs", 300)[0], "100 ms");
  assert.deepEqual(labels("terminalScrollback", 5000).slice(-1), ["100,000 lines"]);
  assert.deepEqual(labels("terminalFontSize", 17).slice(-1), ["17 px (custom)"]);
});

test("paths: auto first, the known candidates, the current value kept; home shown as ~", () => {
  assert.deepEqual(values("vaultRoot", ""), ["", "/h/other-vault"]);
  assert.equal(labels("vaultRoot", "")[0], "this vault (~/vault)");
  assert.deepEqual(values("vaultRoot", "", { ...ENV, agenticosVault: "/h/vault" }), [""], "the same vault is not offered twice");
  assert.deepEqual(values("claudeConfigDir", ""), ["", "/h/.claude"], "duplicates collapse");
  assert.deepEqual(values("nodePath", ""), ["", "/opt/node/bin/node", "/usr/local/bin/node"], "only candidates that exist");
  assert.deepEqual(values("nodePath", "/custom/node"), ["", "/opt/node/bin/node", "/usr/local/bin/node", "/custom/node"]);
  assert.equal(labels("nodePath", "/custom/node").at(-1), "/custom/node (custom)");
  assert.deepEqual(values("terminalShell", ""), ["", "/bin/zsh", "/bin/bash"]);
  assert.equal(labels("terminalShell", "")[0], "system default (/bin/zsh)");
  assert.deepEqual(values("terminalCwd", ""), ["", "/h"]);
});

test("a toggle key has no choices", () => {
  assert.equal(pluginChoices("statusBarEnabled", 1, ENV), null);
});

test("pluginStep (D9): adjacent presets, custom values step to the nearest, ends are null", () => {
  assert.equal(pluginStep("liveTailPollMs", 300, 1), 500);
  assert.equal(pluginStep("liveTailPollMs", 300, -1), 200);
  assert.equal(pluginStep("liveTailPollMs", 5000, 1), null);
  assert.equal(pluginStep("liveTailPollMs", 100, -1), null);
  assert.equal(pluginStep("terminalFontSize", 17, 1), 18);
  assert.equal(pluginStep("terminalFontSize", 17, -1), 16);
  assert.equal(pluginStep("vaultRoot", 1, 1), null);
});

test("parseShells and tildify", () => {
  assert.deepEqual(parseShells("# list\n/bin/zsh\n\n/bin/bash\n"), ["/bin/zsh", "/bin/bash"]);
  assert.equal(tildify("/h/x", "/h"), "~/x");
  assert.equal(tildify("/hx/y", "/h"), "/hx/y");
});
