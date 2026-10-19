#!/usr/bin/env node
'use strict';
/**
 * backlog.js — the idea backlog: <vault>/persona/backlog.md, one Markdown section per accepted `workflow` or `product`
 * proposal (docs/design/specs/2026-09-22-persona-reflect-daily-design.md D5). Written only through this script by
 * the persona-flag-closer review's Accept lane; the file is tracked, unlike STATE.md, so an accepted idea survives.
 *
 *   node backlog.js append <proposal-file> [--by <who>] [--root <vault>]
 *
 * A section: `## <filed> · <kind> · <slug>`, then target, surface (product proposals name the surface a feature run
 * starts from: cli | plugin | brain | hud | vault-template | docs), the accept date, and the proposal's What and Why
 * verbatim with their headings demoted one level. A `self` or `vault` proposal is refused (exit 2) — those are applied,
 * not kept — and so is a slug already in the backlog. Prints one JSON line: { file, slug, kind, surface, filed }.
 */
const fs = require('fs');
const path = require('path');

const IDEA_KINDS = ['workflow', 'product'];
const SURFACES = ['cli', 'plugin', 'brain', 'hud', 'vault-template', 'docs'];
const HEADER = '# Persona backlog\n\nIdeas accepted from the agent\'s `workflow` and `product` proposals, appended by the flag-closer review through `brain/scripts/persona/backlog.js`. Newest last. A product entry names the surface a `/AgenticOS-New-Feature` run starts from.\n';

function defaultFile(root) {
  const vault = root || require('../lib/paths.js').PATHS.VAULT;
  return path.join(vault, 'persona', 'backlog.md');
}

/** The proposal frontmatter subset collect.js reads (inlined: this script is vendored without the plugin; recheck.js shares it). */
function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    const q = v.match(/^"(.*)"$/); if (q) v = q[1].replace(/\\(["\\])/g, '$1');
    fm[kv[1]] = v;
  }
  return fm;
}
/** The body of `## <name>` up to the next H2, trimmed; null when the section is missing. */
function section(text, name) {
  const re = new RegExp(`^## ${name}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm');
  const m = re.exec(text);
  return m ? m[1].replace(/^\n+|\s+$/g, '') : null;
}
function demote(body) { return body.replace(/^(#{1,5}) /gm, '#$1 '); }

/** Parses a proposal file into what the backlog keeps. Throws on a file that is not an accepted idea. */
function parseProposal(file) {
  const text = fs.readFileSync(file, 'utf8');
  const fm = parseFrontmatter(text) || {};
  const slug = fm.slug || path.basename(file, '.md').replace(/^\d{4}-\d{2}-\d{2}-/, '');
  const kind = fm.kind || 'self';
  if (!IDEA_KINDS.includes(kind)) throw new Error(`proposal '${slug}' has kind '${kind}' — only ${IDEA_KINDS.join(' and ')} proposals go to the backlog`);
  const surface = fm.surface || null;
  if (surface && !SURFACES.includes(surface)) throw new Error(`proposal '${slug}' names an unknown surface '${surface}' (${SURFACES.join(' | ')})`);
  return { slug, kind, surface, filed: fm.filed || path.basename(file).slice(0, 10), target: fm.target || '(unspecified)', what: section(text, 'What'), why: section(text, 'Why') };
}

function renderSection(p, { by, now }) {
  const lines = [`## ${p.filed} · ${p.kind} · ${p.slug}`, `- target: ${p.target}`];
  if (p.kind === 'product') lines.push(`- surface: ${p.surface || '(unspecified)'}`);
  lines.push(`- accepted: ${now.toISOString().slice(0, 10)}${by ? ` by ${by}` : ''}`, '', '### What', '', p.what ? demote(p.what) : '(the proposal had no What section)', '', '### Why', '', p.why ? demote(p.why) : '(the proposal had no Why section)', '');
  return lines.join('\n');
}

/** Appends one section; creates the file with its header on first use. Throws on a duplicate slug. */
function append({ proposal, file, by = null, now = new Date() }) {
  const p = parseProposal(proposal);
  let cur = '';
  try { cur = fs.readFileSync(file, 'utf8'); } catch { /* first use */ }
  if (new RegExp(`^## .* · ${p.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(cur)) throw new Error(`'${p.slug}' is already in ${file}`);
  const body = (cur || HEADER) + (cur && !cur.endsWith('\n') ? '\n' : '') + '\n' + renderSection(p, { by, now });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return { file, slug: p.slug, kind: p.kind, surface: p.surface, filed: p.filed };
}

function main(argv, { stdout = (s) => process.stdout.write(s), stderr = (s) => process.stderr.write(s), now = new Date() } = {}) {
  const flags = {}; const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { flags[argv[i].slice(2)] = argv[i + 1]; i++; } else positional.push(argv[i]);
  }
  const [verb, proposal] = positional;
  if (verb !== 'append' || !proposal) { stderr('usage: backlog.js append <proposal-file> [--by <who>] [--root <vault>]\n'); return 2; }
  try {
    const r = append({ proposal, file: defaultFile(flags.root), by: flags.by || null, now });
    stdout(JSON.stringify(r) + '\n');
    return 0;
  } catch (e) { stderr(`backlog: ${e.message}\n`); return 2; }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { IDEA_KINDS, SURFACES, HEADER, defaultFile, parseFrontmatter, parseProposal, section, append, main };
