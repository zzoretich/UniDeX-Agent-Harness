'use strict';
/**
 * config-write.js — the one writer for agenticos.json and <vault>/brain/config.json (spec 2026-09-24-aos-config D4, D5).
 * Pure over explicit files and objects (no paths.js, which resolves a vault at load), so the CLI can use it from the
 * checkout and from the vendored runtime alike.
 *   machine  <claude config dir>/agenticos.json — written by `aos init`, merged last, so it wins
 *   vault    <vault>/brain/config.json          — the product config, merged over config.default.json
 */
const fs = require('fs');
const S = require('./settings-schema.js');

class ConfigFileError extends Error {}

const { isPlainObject, getPath } = S;

/** A file the user owns: missing → null; present but not JSON, or not an object → refused, never replaced. */
function readStrict(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  let obj;
  try { obj = JSON.parse(text); } catch (e) { throw new ConfigFileError(`${file} is not valid JSON (${e.message}); fix it first, nothing was written`); }
  if (!isPlainObject(obj)) throw new ConfigFileError(`${file} is not a JSON object; fix it first, nothing was written`);
  return obj;
}

/**
 * tmp + rename: a hook reading the file sees the whole old file or the whole new one, never half. 2-space indent and the
 * existing key order: the launcher reads agenticos.json one `"key": "value"` line at a time (plugin/bin/aos json_str).
 */
function writeAtomic(file, obj) {
  require('./fsx.js').writeAtomic(file, `${JSON.stringify(obj, null, 2)}\n`); // one implementation (spec 2026-09-24-locked-writers D5)
}

/** A parsed JSON file cannot hold `undefined`, so a key is present exactly when its value is defined (null included). */
function hasPath(obj, key) { return getPath(obj, key) !== undefined; }

/** Sets a dotted key, creating missing parents. A parent that exists but is not an object is refused, not replaced. */
function setPath(obj, key, value) {
  const ks = key.split('.');
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) {
    const k = ks[i];
    if (o[k] === undefined) o[k] = {};
    else if (!isPlainObject(o[k])) throw new ConfigFileError(`cannot set ${key}: ${ks.slice(0, i + 1).join('.')} is not an object in the file`);
    o = o[k];
  }
  o[ks[ks.length - 1]] = value;
  return obj;
}

/** Removes a dotted key and every parent it leaves empty. True when something was removed. */
function unsetPath(obj, key) {
  const ks = key.split('.');
  const chain = [obj];
  for (const k of ks.slice(0, -1)) {
    const next = chain[chain.length - 1][k];
    if (!isPlainObject(next)) return false;
    chain.push(next);
  }
  const last = ks[ks.length - 1];
  if (!Object.prototype.hasOwnProperty.call(chain[chain.length - 1], last)) return false;
  delete chain[chain.length - 1][last];
  for (let i = chain.length - 1; i > 0; i--) {
    if (Object.keys(chain[i]).length) break;
    delete chain[i - 1][ks[i - 1]];
  }
  return true;
}

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}

/**
 * The value in force for one setting and where it comes from: `machine` (agenticos.json), `vault` (brain/config.json)
 * or `default`. Mirrors lib/config.js loadConfig(): a leaf is taken whole from the highest file that has it, except an
 * `object` setting, whose keys merge across the files. A vaultOnly key ignores agenticos.json, as its reader does.
 */
function resolve(e, { userCfg = {}, vaultCfg = {} } = {}) {
  if (e.machine) {
    const v = getPath(userCfg, e.key);
    return { value: v === undefined ? null : v, source: v === undefined ? 'unset' : 'machine' };
  }
  const def = S.defaultOf(e);
  const inUser = !e.vaultOnly && hasPath(userCfg, e.key);
  const inVault = hasPath(vaultCfg, e.key);
  if (e.type === 'object') {
    let v = isPlainObject(def) ? def : {};
    if (inVault && isPlainObject(getPath(vaultCfg, e.key))) v = deepMerge(v, getPath(vaultCfg, e.key));
    if (inUser && isPlainObject(getPath(userCfg, e.key))) v = deepMerge(v, getPath(userCfg, e.key));
    return { value: v, source: inUser ? 'machine' : inVault ? 'vault' : 'default' };
  }
  if (inUser) return { value: getPath(userCfg, e.key), source: 'machine' };
  if (inVault) return { value: getPath(vaultCfg, e.key), source: 'vault' };
  return { value: def, source: 'default' };
}

/** D4: the file a `set` writes — the one that holds the key now (agenticos.json wins the merge), else the vault file. */
function targetFile(e, { userCfg = {} } = {}) {
  if (e.machine) return 'machine';
  if (e.vaultOnly) return 'vault';
  return hasPath(userCfg, e.key) ? 'machine' : 'vault';
}

/** D12: dotted keys in a config file that no setting names (a typo such as telemetry.enabeld). */
function unknownKeys(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (S.entry(key)) continue;
    if (isPlainObject(v) && S.isPrefix(key)) out.push(...unknownKeys(v, key));
    else out.push(key);
  }
  return out;
}

/** D12: settings present in a file whose value fails validation, as { key, message }. */
function invalidValues(obj) {
  const out = [];
  for (const e of S.SETTINGS) {
    if (e.machine || !hasPath(obj, e.key)) continue;
    const message = S.validate(e, getPath(obj, e.key));
    if (message) out.push({ key: e.key, message });
  }
  return out;
}

module.exports = { ConfigFileError, readStrict, writeAtomic, hasPath, getPath, setPath, unsetPath, resolve, targetFile, unknownKeys, invalidValues };
