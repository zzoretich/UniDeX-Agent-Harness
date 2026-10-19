#!/usr/bin/env node
'use strict';
/**
 * proposal-html.js — the HTML page for every proposal (docs/design/specs/2026-09-22-proposal-pages-design.md).
 * The Markdown file in <vault>/persona/proposals/ stays the source. This renders it to
 * <vault>/brain/_index/proposals/<date>-<slug>.html — the gitignored cache folder, so the page outlives the review's
 * decision and the Proposals tab's Backlog and History rows can still open it — and keeps the file's link line
 * pointing at the page. The format every proposal shares:
 *
 *   ---  frontmatter (proposals/README.md)  ---
 *   # <Title>
 *
 *   **[Open the proposal in browser](file:///…/brain/_index/proposals/<date>-<slug>.html)**
 *
 *   ## What · ## Why · ## Risk · ## Premises
 *
 *   node proposal-html.js [--root <vault>] [<proposal.md> …]   render the named files, or every pending proposal
 *
 * A page is rewritten when it is missing, older than its Markdown, or from an older renderer. The Markdown is rewritten
 * (temp file + rename) only when its link line is missing or points elsewhere, so a re-run changes nothing and the
 * tick's `proposals` signature moves once per filing. Prints one JSON line { schema, rendered, linked, skipped, errors }.
 * Exit 0 on every path but a usage error (2). Under AOS_HEADLESS=1 (a duty) --root must be the vault and every named
 * file must sit in <vault>/persona/proposals (lib/pin-root.js, spec 2026-09-23-duty-write-scope-design D3).
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { IDEA_KINDS, parseFrontmatter } = require('./backlog.js');
const { toHtml, inline, esc } = require('../lib/markdown-html.js');
const { assertPinned } = require('../lib/pin-root.js');
const { links } = require('../lib/hud-host.js');

const SCHEMA = 1;
// Bumped when the page changes shape, so a page cached by an older renderer is rebuilt (2: the AgenticOS link).
const RENDERER = '2';
const PAGES_DIR = path.join('brain', '_index', 'proposals');
const LINK_LABEL = 'Open the proposal in browser';
const LINK_RE = /^\*\*\[Open the proposal in browser\]\(([^)\s]*)\)\*\*/m;
const LINK_SEP_RE = /^\*\*\[Open the proposal in browser\]\([^)\s]*\)\*\*(?:[ \t]*·[ \t]*)?/m;
const RENDERER_META = `<meta name="aos-renderer" content="${RENDERER}">`;
const USAGE = 'usage: proposal-html.js [--root <vault>] [<proposal.md> …]\n';

function defaultRoot(root) { return root || require('../lib/paths.js').PATHS.VAULT; }
function isProposalFile(name) { return name.endsWith('.md') && name !== 'README.md'; }
/** <root>/brain/_index/proposals/<proposal file name>.html */
function pagePath(root, name) { return path.join(root, PAGES_DIR, `${path.basename(name, '.md')}.html`); }
function linkLine(url) { return `**[${LINK_LABEL}](${url})**`; }
function localDay(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** The frontmatter block, the head (title, link line, intro) and the body from the first `## ` heading. */
function parts(text) {
  const fm = /^---\n[\s\S]*?\n---\n/.exec(text);
  const start = fm ? fm[0].length : 0;
  const rest = text.slice(start);
  const h2 = /^## /m.exec(rest);
  const cut = h2 ? h2.index : rest.length;
  return { front: text.slice(0, start), head: rest.slice(0, cut), body: rest.slice(cut) };
}

/** The file text with its link line pointing at `url`: replaced in place, else put after the `# ` title, else first. */
function withLinkLine(text, url) {
  const { front, head, body } = parts(text);
  const line = linkLine(url);
  const m = LINK_RE.exec(head);
  if (m) return m[1] === url ? text : front + head.replace(LINK_RE, () => line) + body;
  const h1 = /^# .*$/m.exec(head);
  const at = h1 ? h1.index + h1[0].length : head.length - head.replace(/^\n+/, '').length;
  const after = head.slice(at).replace(/^\n+/, '');
  const lead = h1 ? `${head.slice(0, at)}\n\n` : head.slice(0, at);
  return `${front}${lead}${line}\n${after ? `\n${after}` : '\n'}${body}`;
}

function titleOf(head, fm, slug) {
  const h1 = /^# (.+?)\s*#*\s*$/m.exec(head);
  if (h1) return h1[1];
  if (fm.title) return fm.title;
  return slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' ');
}

/** The `## ` sections of the body, in file order. */
function sectionsOf(body) {
  const heads = [...body.matchAll(/^## (.+?)\s*$/gm)];
  return heads.map((h, k) => ({
    name: h[1],
    text: body.slice(h.index + h[0].length, k + 1 < heads.length ? heads[k + 1].index : body.length).replace(/^\n+|\s+$/g, ''),
  }));
}

/** collect.js parsePremiseTable: rows whose second cell is VERIFIED or ASSUMED. */
function premiseRows(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
    if (cells.length >= 3 && /^(VERIFIED|ASSUMED)$/.test(cells[1])) rows.push({ claim: cells[0], status: cells[1], evidence: cells.slice(2).join(' | ') });
  }
  return rows;
}

function premisesHtml(text) {
  const rows = premiseRows(text);
  if (!rows.length) return toHtml(text);
  const v = rows.filter((r) => r.status === 'VERIFIED').length;
  const tr = rows.map((r) => `<tr><td>${inline(r.claim)}</td><td><span class="pill ${r.status === 'VERIFIED' ? 'ok' : 'warn'}">${r.status}</span></td><td>${inline(r.evidence)}</td></tr>`).join('\n');
  return `<p class="sub">${v} verified · ${rows.length - v} assumed</p>\n<div class="table"><table>\n<thead><tr><th>Premise</th><th>Status</th><th>Evidence</th></tr></thead>\n<tbody>\n${tr}\n</tbody>\n</table></div>`;
}

const STYLE = `
:root{--bg:#f7f7f5;--card:#fff;--ink:#1a1a1a;--sub:#6b6b6b;--line:#e2e2de;--link:#1f5fbf;--ok:#2e7d32;--warn:#b45309;--cyan:#0e7490;--add:#e6f4ea;--del:#fdecea}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#161618;--card:#1f1f23;--ink:#ececec;--sub:#9a9aa2;--line:#33333a;--link:#7fb0ff;--ok:#66bb6a;--warn:#f0a35a;--cyan:#4fc3dc;--add:#16301d;--del:#3a1d1d}}
:root[data-theme="dark"]{--bg:#161618;--card:#1f1f23;--ink:#ececec;--sub:#9a9aa2;--line:#33333a;--link:#7fb0ff;--ok:#66bb6a;--warn:#f0a35a;--cyan:#4fc3dc;--add:#16301d;--del:#3a1d1d}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,system-ui,sans-serif;max-width:860px;margin:0 auto;padding:2rem 16px 4rem}
a{color:var(--link)}
h1{font-size:1.75rem;line-height:1.25;margin:.25rem 0 .75rem}
h2{font-size:1.15rem;margin:2.25rem 0 .5rem;padding-bottom:.25rem;border-bottom:1px solid var(--line)}
h3,h4{font-size:1rem;margin:1.25rem 0 .25rem}
.eyebrow,.sub,footer{color:var(--sub);font-size:.875rem}
.eyebrow{margin:0}
.meta{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.75rem 1rem;margin:1rem 0}
.meta dt{color:var(--sub)}.meta dd{margin:0;overflow-wrap:anywhere}
.links{font-size:.875rem}
.pill{display:inline-block;padding:0 .55rem;border-radius:1rem;border:1px solid currentColor;font-size:.8em;font-weight:600;white-space:nowrap}
.pill.ok{color:var(--ok)}.pill.warn,.warn{color:var(--warn)}.pill.kind{color:var(--cyan)}
code{font:.875em ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--card);border:1px solid var(--line);border-radius:4px;padding:0 .25rem;overflow-wrap:anywhere}
pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:.75rem;overflow-x:auto}
pre code{border:0;padding:0;background:none}
pre .add{display:block;background:var(--add)}pre .del{display:block;background:var(--del)}pre .hunk{color:var(--cyan)}
.table{overflow-x:auto}
table{width:100%;border-collapse:collapse;background:var(--card);font-size:.925rem}
th,td{border:1px solid var(--line);padding:.45rem .6rem;text-align:left;vertical-align:top}
blockquote{margin:1rem 0;padding:0 1rem;border-left:3px solid var(--line);color:var(--sub)}
footer{margin-top:3rem;border-top:1px solid var(--line);padding-top:1rem}
`;

/** The page for one proposal file: `name` is its file name, `file` its absolute path. Pure. */
function renderPage({ name, text, file, now = new Date() }) {
  const fm = parseFrontmatter(text) || {};
  const slug = fm.slug || name.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
  const kind = fm.kind || 'self';
  const { head, body } = parts(text);
  const title = titleOf(head, fm, slug);
  const intro = head.replace(/^# .*$/m, '').replace(LINK_SEP_RE, '').trim();
  const meta = [
    ['Target', esc(fm.target || '(unspecified)')],
    ['Decision', IDEA_KINDS.includes(kind) ? 'Accept (kept in the backlog) or dismiss' : 'Approve (applied exactly as written) or reject'],
    ['Recheck', fm.recheck ? `<code>${esc(fm.recheck)}</code>` : '<span class="warn">none — the review cannot re-verify it</span>'],
    fm.autoapply_class ? ['Auto-apply class', esc(fm.autoapply_class)] : null,
  ].filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  const sections = sectionsOf(body).map((s) => `<section>\n<h2>${inline(s.name)}</h2>\n${s.name === 'Premises' ? premisesHtml(s.text) : toHtml(s.text)}\n</section>`).join('\n');
  const eyebrow = [`Proposal · <span class="pill kind">${esc(kind)}</span>`, fm.surface ? `surface ${esc(fm.surface)}` : null, `filed ${esc(fm.filed || name.slice(0, 10))}`, esc(slug)].filter(Boolean).join(' · ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
${RENDERER_META}
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
<p class="eyebrow">${eyebrow}</p>
<h1>${inline(title)}</h1>
${intro ? `<div class="intro">${toHtml(intro)}</div>\n` : ''}<dl class="meta">${meta}</dl>
<p class="links"><a href="${esc(links().file(`persona/proposals/${name}`))}">Open in AgenticOS</a> · <a href="${esc(pathToFileURL(file).href)}">Markdown source</a></p>
</header>
<main>
${sections || '<p class="sub">This proposal has no sections yet.</p>'}
</main>
<footer>Rendered ${localDay(now)} from <code>persona/proposals/${esc(name)}</code>. The Markdown file is the source; decide it in a Claude Code or Codex session with “review persona flags”.</footer>
</body>
</html>
`;
}

function fresh(page, md) {
  try {
    return fs.statSync(page).mtimeMs >= fs.statSync(md).mtimeMs && fs.readFileSync(page, 'utf8').includes(RENDERER_META);
  } catch { return false; }
}

/** Renders `files` (absolute paths), or every pending proposal under <root>/persona/proposals. */
function render({ root = defaultRoot(), files = null, now = new Date() } = {}) {
  const out = { schema: SCHEMA, rendered: [], linked: [], skipped: 0, errors: [] };
  let list = files;
  if (!list) {
    const dir = path.join(root, 'persona', 'proposals');
    try { list = fs.readdirSync(dir).filter(isProposalFile).sort().map((n) => path.join(dir, n)); } catch { return out; }
  }
  for (const file of list) {
    const name = path.basename(file);
    try {
      if (!isProposalFile(name)) throw new Error('not a proposal file');
      let text = fs.readFileSync(file, 'utf8');
      const page = pagePath(root, name);
      const next = withLinkLine(text, pathToFileURL(page).href);
      if (next !== text) { writeAtomic(file, next); text = next; out.linked.push(name); }
      if (fresh(page, file)) { out.skipped++; continue; }
      writeAtomic(page, renderPage({ name, text, file, now }));
      out.rendered.push(name);
    } catch (e) {
      out.errors.push(`${name}: ${e.message}`);
    }
  }
  return out;
}

function main(argv, { stdout = (s) => process.stdout.write(s), stderr = (s) => process.stderr.write(s), now = new Date() } = {}) {
  const rootIx = argv.indexOf('--root');
  if (rootIx >= 0 && (!argv[rootIx + 1] || argv[rootIx + 1].startsWith('--'))) { stderr(USAGE); return 2; }
  const positional = argv.filter((a, i) => rootIx < 0 || (i !== rootIx && i !== rootIx + 1));
  if (positional.some((a) => a.startsWith('--'))) { stderr(USAGE); return 2; }
  const files = positional.length ? positional.map((p) => path.resolve(p)) : null;
  let root;
  try {
    assertPinned({ root: rootIx >= 0 ? argv[rootIx + 1] : null, within: files || [], withinRel: path.join('persona', 'proposals') });
    root = rootIx >= 0 ? path.resolve(argv[rootIx + 1]) : defaultRoot();
  } catch (e) { stderr(`proposal-html: ${e.message}\n`); return 2; }
  if (!root) { stderr('proposal-html: no vault — pass --root <vault> or run `aos init`\n'); return 2; }
  stdout(JSON.stringify(render({ root, files, now })) + '\n');
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { SCHEMA, RENDERER, PAGES_DIR, LINK_LABEL, pagePath, linkLine, withLinkLine, renderPage, premiseRows, render, main };
