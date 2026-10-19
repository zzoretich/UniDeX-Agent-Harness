// Light and dark (UniDeX D6): the saved choice in <userData>/app-settings.json, the window backgrounds, the bridge's
// argument check, View ▸ Appearance, and the toggle's next choice.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { THEMES } from "../../../hud/src/ui/tokens";
import { ThemeSetArgs } from "../../src/main/ipc/schemas";
import { appearanceItem } from "../../src/main/menu";
import { WINDOW_BG, loadThemeSource, saveThemeSource, windowBackground } from "../../src/main/theme";
import { toggledSource } from "../../src/renderer/theme";
import type { ThemeSource } from "../../src/shared/ipc";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aos-theme-")));
process.on("exit", () => fs.rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const userData = (): string => path.join(ROOT, `u${n++}`);

test("with no saved choice, the app follows macOS", () => {
  assert.equal(loadThemeSource(userData()), "system");
});

test("a saved choice comes back, and the file keeps what else it holds", () => {
  const dir = userData();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "app-settings.json"), JSON.stringify({ other: 1 }));
  saveThemeSource(dir, "dark");
  assert.equal(loadThemeSource(dir), "dark");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "app-settings.json"), "utf8")), { other: 1, theme: "dark" });
  assert.equal(fs.existsSync(path.join(dir, "app-settings.json.tmp")), false);
  saveThemeSource(dir, "system");
  assert.equal(loadThemeSource(dir), "system");
});

test("a damaged or unknown choice reads as follow macOS", () => {
  for (const body of ["{not json", JSON.stringify({ theme: "sepia" }), JSON.stringify(["dark"]), JSON.stringify({ theme: 1 })]) {
    const dir = userData();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "app-settings.json"), body);
    assert.equal(loadThemeSource(dir), "system", body);
  }
});

test("a window's background before the page paints is the tokens' page colour", () => {
  assert.equal(WINDOW_BG.light, THEMES.light.bg);
  assert.equal(WINDOW_BG.dark, THEMES.dark.bg);
  assert.equal(windowBackground(true), THEMES.dark.bg);
  assert.equal(windowBackground(false), THEMES.light.bg);
});

test("the page may only name one of the three choices", () => {
  for (const source of ["system", "light", "dark"]) assert.equal(ThemeSetArgs.safeParse({ source }).success, true, source);
  for (const bad of [{ source: "sepia" }, { source: "" }, {}, { source: "dark", extra: 1 }, "dark", null]) {
    assert.equal(ThemeSetArgs.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("View ▸ Appearance checks the current choice and sets the one clicked", () => {
  const set: ThemeSource[] = [];
  const item = appearanceItem({ source: "light", set: (s) => set.push(s) });
  assert.equal(item.label, "Appearance");
  const choices = item.submenu as Array<{ label: string; type: string; checked: boolean; click: () => void }>;
  assert.deepEqual(choices.map((c) => [c.label, c.type, c.checked]), [["Match macOS", "radio", false], ["Light", "radio", true], ["Dark", "radio", false]]);
  choices[2].click();
  choices[0].click();
  assert.deepEqual(set, ["dark", "system"]);
});

test("the toggle switches to the opposite of what shows, as an explicit choice", () => {
  assert.equal(toggledSource({ source: "system", dark: true }), "light");
  assert.equal(toggledSource({ source: "system", dark: false }), "dark");
  assert.equal(toggledSource({ source: "dark", dark: true }), "light");
  assert.equal(toggledSource({ source: "light", dark: false }), "dark");
});
