'use strict';
/**
 * power.js — is this machine running on battery? (local-first A18: heavy local jobs such as the semantic graph pass
 * wait for the charger while `local.onBattery` is `defer`.)
 *
 *   onBattery({ exec, platform, readFile, readdir }) → true | false
 *     macOS: `pmset -g batt` says "Now drawing from 'Battery Power'". Linux: /sys/class/power_supply has a mains supply
 *     (type Mains) and none of them is online. Anything else, or anything that cannot be read (a desktop, no pmset, a
 *     container), is false: a check that cannot tell never holds the work back.
 *   deferOnBattery(cfg, deps) → true when local.onBattery is not `run` and onBattery() says so.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SUPPLIES = '/sys/class/power_supply';

function onBattery({ exec = spawnSync, platform = process.platform, readFile = fs.readFileSync, readdir = fs.readdirSync } = {}) {
  try {
    if (platform === 'darwin') {
      const r = exec('pmset', ['-g', 'batt'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      return !r.error && r.status === 0 && /drawing from 'Battery Power'/.test(String(r.stdout || ''));
    }
    if (platform === 'linux') {
      const mains = readdir(SUPPLIES).filter((n) => {
        try { return String(readFile(path.join(SUPPLIES, n, 'type'), 'utf8')).trim() === 'Mains'; } catch { return false; }
      });
      if (!mains.length) return false;
      return mains.every((n) => {
        try { return String(readFile(path.join(SUPPLIES, n, 'online'), 'utf8')).trim() === '0'; } catch { return false; }
      });
    }
  } catch { /* cannot tell: not on battery */ }
  return false;
}

function deferOnBattery(cfg, deps = {}) {
  const l = (cfg && cfg.local) || {};
  if (l.onBattery === 'run') return false;
  return (deps.onBattery || onBattery)(deps);
}

module.exports = { onBattery, deferOnBattery };
