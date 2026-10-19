import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseObsidianGit, parseLaunchdPlist, describePlist, readLaunchdRows, readExternalSchedules, OBSIDIAN_GIT_DATA } from "./externalSchedules";

test("parseObsidianGit: timers on, timers off, absent, corrupt", () => {
  const on = parseObsidianGit(JSON.stringify({ autoSaveInterval: 60, autoPushInterval: 60, autoBackupAfterFileChange: false }));
  assert.equal(on?.name, "Vault backup");
  assert.equal(on?.cadence, "backup every 60 min, push every 60 min");
  const idle = parseObsidianGit(JSON.stringify({ autoSaveInterval: 30, autoBackupAfterFileChange: true }));
  assert.equal(idle?.cadence, "backup every 30 min (after a change)");
  assert.equal(parseObsidianGit(JSON.stringify({ autoSaveInterval: 0 })), null);
  assert.equal(parseObsidianGit(null), null);
  assert.equal(parseObsidianGit("{nope"), null);
});

const PLIST = `<?xml version="1.0"?><plist version="1.0"><dict>
  <key>Label</key><string>com.example.nightly</string>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>7</integer><key>Minute</key><integer>45</integer></dict>
    <dict><key>Weekday</key><integer>2</integer><key>Hour</key><integer>7</integer><key>Minute</key><integer>45</integer></dict>
    <dict><key>Weekday</key><integer>3</integer><key>Hour</key><integer>7</integer><key>Minute</key><integer>45</integer></dict>
    <dict><key>Weekday</key><integer>4</integer><key>Hour</key><integer>7</integer><key>Minute</key><integer>45</integer></dict>
    <dict><key>Weekday</key><integer>5</integer><key>Hour</key><integer>7</integer><key>Minute</key><integer>45</integer></dict>
  </array>
</dict></plist>`;

test("parseLaunchdPlist + describePlist: calendar array, single dict, StartInterval, nothing", () => {
  const p = parseLaunchdPlist(PLIST);
  assert.equal(p.label, "com.example.nightly");
  assert.equal(p.calendar.length, 5);
  assert.equal(describePlist(p), "Weekdays at 07:45");
  const single = parseLaunchdPlist("<dict><key>Label</key><string>x</string><key>StartCalendarInterval</key><dict><key>Hour</key><integer>13</integer><key>Minute</key><integer>0</integer></dict></dict>");
  assert.equal(describePlist(single), "Every day at 13:00");
  assert.equal(describePlist(parseLaunchdPlist("<dict><key>StartInterval</key><integer>3600</integer></dict>")), "every 1 h");
  assert.equal(describePlist(parseLaunchdPlist("<dict><key>StartInterval</key><integer>900</integer></dict>")), "every 15 min");
  assert.equal(describePlist(parseLaunchdPlist("<dict><key>KeepAlive</key><true/></dict>")), "no schedule (on demand)");
});

test("readLaunchdRows: allow-listed labels only, missing plist is 'not loaded', bad labels dropped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "la-"));
  fs.writeFileSync(path.join(dir, "com.example.nightly.plist"), PLIST);
  const rows = readLaunchdRows(["com.example.nightly", "com.example.absent", "../etc/evil"], dir);
  assert.deepEqual(rows.map((r) => [r.id, r.cadence, r.loaded]), [["com.example.nightly", "Weekdays at 07:45", true], ["com.example.absent", "not loaded (no plist)", false]]);
});

test("readExternalSchedules: git row from the vault, launchd rows only on darwin, never throws", () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "ext-vault-"));
  fs.mkdirSync(path.dirname(path.join(vault, OBSIDIAN_GIT_DATA)), { recursive: true });
  fs.writeFileSync(path.join(vault, OBSIDIAN_GIT_DATA), JSON.stringify({ autoSaveInterval: 60 }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "la-"));
  fs.writeFileSync(path.join(dir, "com.example.nightly.plist"), PLIST);
  const mac = readExternalSchedules(vault, ["com.example.nightly"], { launchAgents: dir, platform: "darwin" });
  assert.deepEqual(mac.map((r) => r.id), ["obsidian-git", "com.example.nightly"]);
  const linux = readExternalSchedules(vault, ["com.example.nightly"], { launchAgents: dir, platform: "linux" });
  assert.deepEqual(linux.map((r) => r.id), ["obsidian-git"]);
  assert.deepEqual(readExternalSchedules(fs.mkdtempSync(path.join(os.tmpdir(), "empty-")), [], { platform: "linux" }), []);
});
