#!/usr/bin/env node
// persona-flag-closer collector: pending proposals + STATE.md flags + new silent failures.
// Usage: node collect.js [--root <vaultRoot>] [--update-state] [--counts]
// --update-state consumes error-log offsets and records the pending-set hash — one call per review.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/** The vault: --root, else AOS_VAULT, else "vault" in <configDir>/agenticos.json (AOS_CONFIG overrides the path). */
function defaultRoot() {
  if (process.env.AOS_VAULT) return process.env.AOS_VAULT;
  const cfg = process.env.AOS_CONFIG || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'agenticos.json');
  try { return JSON.parse(fs.readFileSync(cfg, 'utf8')).vault || null; } catch { return null; }
}
/** run-duty.sh writes duty-<name>-error.log here. */
function defaultLogDir(root) { return process.env.PERSONA_LOG_DIR || path.join(root, 'persona', 'journal', 'logs'); }

/** Proposal kinds (spec 2026-09-22 D9): self and vault are applied on approval; workflow and product go to the backlog. */
const KINDS = ['self', 'vault', 'workflow', 'product'];
const IDEA_KINDS = ['workflow', 'product'];
/** Where a product proposal would land — the surfaces a feature run knows (reflect-daily spec D5). */
const SURFACES = ['cli', 'plugin', 'brain', 'hud', 'vault-template', 'docs'];

/** The review verbs for a kind: an applied change is approved or rejected, an idea is accepted (to the backlog) or dismissed. */
function verbsFor(kind) {
  return IDEA_KINDS.includes(kind)
    ? { accept: 'Accept', decline: 'Dismiss', defer: 'Defer', label: 'accept → backlog / dismiss', route: 'backlog' }
    : { accept: 'Approve', decline: 'Reject', defer: 'Defer', label: 'approve / reject', route: 'apply' };
}

function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) {
      let v = kv[2].trim();
      const q = v.match(/^"(.*)"$/); if (q) v = q[1].replace(/\\(["\\])/g, '$1');
      fm[kv[1]] = v;
    }
  }
  return fm;
}

/** A `workspace:` value as a workspace name (spaces-redesign D27), as the Workbench reads a memory note's: quotes, a
 *  `[[link]]` and a leading `workspaces/` stripped; null when empty. Mirrored by the HUD's memories.ts workspaceKey. */
function workspaceKey(raw) {
  if (raw == null) return null;
  let v = String(raw).trim();
  const q = /^(["'])(.*)\1$/.exec(v); if (q) v = q[2].trim();
  const link = /^\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/.exec(v); if (link) v = link[1].trim();
  v = v.replace(/^workspaces\//, '').replace(/\/+$/, '').trim();
  return v || null;
}

function parsePremiseTable(text) {
  const sec = text.split(/^## Premises\s*$/m)[1];
  if (!sec) return null;
  const rows = [];
  for (const line of sec.split('\n')) {
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length >= 3 && /^(VERIFIED|ASSUMED)$/.test(cells[1]))
      rows.push({ claim: cells[0], status: cells[1], evidence: cells.slice(2).join(' | ') });
  }
  return rows.length ? rows : null;
}

function collectProposals(root) {
  const dir = path.join(root, 'persona/proposals');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'README.md').sort().map(f => {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const fm = parseFrontmatter(text) || {};
    const premises = parsePremiseTable(text);
    const lint = [];
    if (!fm.recheck) lint.push('missing recheck recipe');
    if (!premises) lint.push('missing premise table');
    const kind = fm.kind || 'self';
    if (!KINDS.includes(kind)) lint.push(`unknown kind "${kind}" (self | vault | workflow | product)`);
    const surface = fm.surface || null;
    if (kind === 'product' && !surface) lint.push(`product proposal names no surface (${SURFACES.join(' | ')})`);
    if (surface && !SURFACES.includes(surface)) lint.push(`unknown surface "${surface}" (${SURFACES.join(' | ')})`);
    const slug = fm.slug || f.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
    return { file: path.join(dir, f), slug, filed: fm.filed || f.slice(0, 10), kind, surface, verbs: verbsFor(kind),
             workspace: workspaceKey(fm.workspace), target: fm.target || '(unspecified)', recheck: fm.recheck || null,
             premises: premises || [], lint };
  });
}

function collectFlags(root) {
  const p = path.join(root, 'persona/STATE.md');
  if (!fs.existsSync(p)) return [];
  const sec = fs.readFileSync(p, 'utf8').split(/^## Flags\s*$/m)[1];
  if (!sec) return [];
  return sec.split(/^## /m)[0].split('\n')
    .filter(l => l.trim().startsWith('- [ ]'))
    .map(l => ({ raw: l.trim(), text: l.trim().replace(/^- \[ \]\s*/, '') }));
}

function collectLogFindings(logDir, stateDir, updateState) {
  const offsetsPath = path.join(stateDir, 'log-offsets.json');
  let offsets = {};
  try { offsets = JSON.parse(fs.readFileSync(offsetsPath, 'utf8')); } catch (_) {}
  const findings = [];
  const files = fs.existsSync(logDir)
    ? fs.readdirSync(logDir).filter(f => /^duty-.*-error\.log$/.test(f)) : [];
  for (const f of files) {
    const full = path.join(logDir, f);
    const size = fs.statSync(full).size;
    const stored = offsets[f] || 0;
    const from = stored > size ? 0 : stored; // a rotated/replaced log (shrunk below the stored offset) resets to a full re-read; normal growth is unaffected
    const buf = Buffer.alloc(size - from);
    if (buf.length) {
      const fd = fs.openSync(full, 'r');
      fs.readSync(fd, buf, 0, buf.length, from);
      fs.closeSync(fd);
    }
    const lines = stripAnsi(buf.toString('utf8')).split('\n')
      .map(l => l.trim()).filter(Boolean).slice(-50);
    if (lines.length) findings.push({ log: full, lines });
    offsets[f] = size;
  }
  if (updateState) {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(offsetsPath, JSON.stringify(offsets, null, 2));
  }
  return findings;
}

function pendingHash(proposals, flags) {
  return crypto.createHash('sha256').update(JSON.stringify({
    p: proposals.map(p => p.slug).sort(),
    f: flags.map(f => f.text).sort()
  })).digest('hex');
}

function collect(root, opts = {}) {
  const stateDir = opts.stateDir || path.join(root, 'persona/flag-closer');
  const proposals = collectProposals(root);
  const flags = collectFlags(root);
  const logFindings = collectLogFindings(opts.logDir || defaultLogDir(root), stateDir, !!opts.updateState);
  const hash = pendingHash(proposals, flags);
  const hashPath = path.join(stateDir, 'last-hash.txt');
  let prev = null;
  try { prev = fs.readFileSync(hashPath, 'utf8').trim(); } catch (_) {}
  if (opts.updateState) {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(hashPath, hash);
  }
  return { generated: new Date().toISOString(), root, proposals, flags, logFindings,
           pendingHash: hash, changedSinceLastRun: prev !== hash || logFindings.length > 0 };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const rootIx = args.indexOf('--root');
  const root = rootIx >= 0 ? args[rootIx + 1] : defaultRoot();
  if (!root) { console.error('collect: no vault — pass --root <vault> or run `aos init`'); process.exit(2); }
  const out = collect(root, { updateState: args.includes('--update-state') });
  if (args.includes('--counts')) {
    const n = out.proposals.length + out.flags.length + out.logFindings.length;
    if (n) console.log(`Persona flag-closer: ${out.proposals.length} proposal(s), ${out.flags.length} flag(s), ${out.logFindings.length} log(s) with new errors — say "review persona flags".`);
  } else {
    console.log(JSON.stringify(out, null, 2));
  }
}
module.exports = { collect, parseFrontmatter, parsePremiseTable, workspaceKey, collectFlags, stripAnsi, defaultRoot, defaultLogDir, verbsFor, KINDS, IDEA_KINDS, SURFACES };
