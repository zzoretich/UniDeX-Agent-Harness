'use strict';
/**
 * power.js — whether this machine is running on battery, for heavy local work that waits for the charger
 * (local-first A18: `local.onBattery: defer`; install-import B10: the history digest).
 *
 *   onBattery(opts) → true | false
 *     macOS  `pmset -g batt` names its source: "Now drawing from 'Battery Power'" (or 'AC Power')
 *     Linux  /sys/class/power_supply: a mains supply that is online means AC; else a battery that is Discharging
 *     other, or anything unreadable → false (never defer work on a guess)
 *   deferOnBattery(cfg, opts) → true when cfg.local.onBattery is `defer` (the default) and onBattery() says so (or
 *     opts.onBattery(), a caller's own answer: the graph's semantic pass, local-first A14).
 *
 * Every input is injectable (platform, exec, sysDir), so tests never ask the real machine.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function readTrim(file) { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; } }

function onBattery({ platform = process.platform, exec = spawnSync, sysDir = '/sys/class/power_supply' } = {}) {
  if (platform === 'darwin') {
    let r;
    try { r = exec('pmset', ['-g', 'batt'], { encoding: 'utf8', timeout: 3000 }); } catch { return false; }
    return !!r && r.status === 0 && /'Battery Power'/.test(String(r.stdout || ''));
  }
  if (platform === 'linux') {
    let names = [];
    try { names = fs.readdirSync(sysDir); } catch { return false; }
    let discharging = false;
    for (const n of names) {
      const dir = path.join(sysDir, n);
      const type = readTrim(path.join(dir, 'type'));
      if (type === 'Mains' && readTrim(path.join(dir, 'online')) === '1') return false;
      if (type === 'Battery' && readTrim(path.join(dir, 'status')) === 'Discharging') discharging = true;
    }
    return discharging;
  }
  return false;
}

function deferOnBattery(cfg, opts = {}) {
  const mode = cfg && cfg.local && cfg.local.onBattery;
  if (mode === 'run') return false;
  // A caller's own answer (graph-build.js semanticSkip's `power` seam) stands in for asking the machine.
  if (typeof opts.onBattery === 'function') return !!opts.onBattery();
  return onBattery(opts);
}

module.exports = { onBattery, deferOnBattery };
