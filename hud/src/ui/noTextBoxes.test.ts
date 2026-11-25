import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

// Spec 2026-09-24-settings-pickers D1: every setting is a toggle, a picker or a button. The runtime's drift test keeps
// every system setting pickable; this keeps the views from growing a text field again. A team's Settings and an agent's
// profile in the Agent Workspace hold to the same rule (agent-workspace D10, D11, D17; agent-teams D12), with the seat
// pickers they share in teams/ui.ts; the Channel's message box is data entry.
const VIEWS = [
  "src/views/SettingsTab.ts", "src/ui/pluginSettingRows.ts", "src/settings.ts", "src/views/teams/ui.ts",
  "src/views/workspace/AgentPane.ts", "src/views/workspace/SettingsPane.ts",
];

test("no text boxes in the Settings tab, the shared plugin rows, Obsidian's settings pane, the seat pickers, AgentPane and SettingsPane", () => {
  for (const rel of VIEWS) {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", rel), "utf8");
    for (const banned of ["addText(", "addTextArea(", "addSearch(", 'type: "text"', "createEl(\"input\", { attr: { type: \"text\"", "<textarea", 'createEl("textarea"']) {
      assert.ok(!src.includes(banned), `${rel} uses ${banned}`);
    }
  }
});
