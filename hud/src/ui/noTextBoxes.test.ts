import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

// Spec 2026-09-24-settings-pickers D1: every setting is a toggle, a picker or a button. The runtime's drift test keeps
// every system setting pickable; this keeps the views from growing a text field again. The Agent Teams tab's Manage pane
// holds to the same rule (spec 2026-09-28-agent-teams-design D12); its Interact pane's message box is data entry.
const VIEWS = ["src/views/SettingsTab.ts", "src/ui/pluginSettingRows.ts", "src/settings.ts", "src/views/teams/ManagePane.ts"];

test("no text boxes in the Settings tab, the shared plugin rows, Obsidian's settings pane or the Agent Teams Manage pane", () => {
  for (const rel of VIEWS) {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", rel), "utf8");
    for (const banned of ["addText(", "addTextArea(", "addSearch(", 'type: "text"', "createEl(\"input\", { attr: { type: \"text\"", "<textarea", 'createEl("textarea"']) {
      assert.ok(!src.includes(banned), `${rel} uses ${banned}`);
    }
  }
});
