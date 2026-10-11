'use strict';
/**
 * build-brain-md.js — compiles brain/_index/BRAIN.md from the memory store,
 * and regenerates the "## Manual index" section of the 3 MOC files. Pure
 * compilation — no model calls, no judgment calls: every section is a
 * mechanical projection of frontmatter (`pin: true`, `status/active`) and
 * MEMORY.md lines.
 *
 * Hard 850-token budget, enforced BEFORE any write: the whole document is
 * composed and measured first, and only written (tmp+rename) if it fits.
 * update-session.js also owns this file's "## Last Session" block (Stop-hook
 * rewrites it every session) — this compiler never regenerates that block,
 * only lifts it from whatever is currently on disk, so the two writers never
 * fight over the same bytes.
 *
 * That borrowed block is the document's one variable-length part, and its
 * writer has no view of this budget — so it is CLAMPED to whatever headroom
 * the compiler-owned sections leave, never allowed to fail the compile. A long
 * session summary must not be able to freeze BRAIN.md.
 * Active projects are listed newest first (frontmatter `updated`) and give way
 * next: auto-wrap files every project it extracts as status/active, so that
 * list grows with no one pruning it. When it would crowd out the Last Session
 * floor, the oldest projects drop off and one line counts them and points at
 * MOC-projects. Only pinned rules overflowing still throws — they are pinned
 * by hand, so that is actionable by pruning the store.
 *
 * The 3 MOCs do NOT share that budget, so they are written first and a BRAIN.md
 * overflow leaves them fresh. Per-bullet descriptions are clamped to
 * BULLET_DESC_CHARS so a verbose MEMORY.md line cannot silently walk the
 * compiler-owned sections into overflow.
 */
const fs = require('fs');
const path = require('path');
const { PATHS } = require('./lib/paths.js');
const { estimateTokens } = require('./lib/text-budget.js');
const { readFrontmatter } = require('./collectors/util.js');
const { withReport } = require('./lib/pipeline-report.js');
const fsx = require('./lib/fsx.js');

// Raised 500 → 850 on 2026-09-04: the fixed skeleton + quick links + Who
// paragraph (~950 chars) left room for only ~9 bullets, and 7 pinned rules +
// 7 active projects overflowed it, freezing BRAIN.md for eight days.
const BUDGET = 850;
// Floor on the headroom left for the borrowed "## Last Session" block. Below
// this the block cannot carry its heading + date line plus any summary at all,
// which means the compiler-owned sections are themselves the problem.
const MIN_LAST_SESSION_CHARS = 96;
// Per-bullet description ceiling for "## Critical rules" / "## Active context".
// These sections are the document's unbounded growth path: every new pinned
// rule or active project adds a line whose length is whatever MEMORY.md's
// description happens to be, and once they crowd out MIN_LAST_SESSION_CHARS the
// whole compile throws. Clamping the description bounds that growth without
// ever dropping an entry — the bold title still identifies every rule, and
// MEMORY.md keeps the untruncated text.
const BULLET_DESC_CHARS = 72;
const TTL = '24h';

// Quick links come from config (quickLinks: string[]); the shipped defaults are neutral
// pointers, and a vault can replace them in brain/config.json.
const { loadConfig } = require('./lib/config.js');
const QUICK_LINKS = (loadConfig().quickLinks || []).join('\n');

function todayIso() { return new Date().toISOString().slice(0, 10); }

function listMdFiles(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); }
  catch { return []; }
}

function readBody(absPath) {
  let raw;
  try { raw = fs.readFileSync(absPath, 'utf8'); } catch { return ''; }
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

/** First non-heading, non-blank paragraph of a memory body (blank-line delimited). */
function firstParagraph(body) {
  const blocks = body.split(/\r?\n\s*\r?\n/).map((b) => b.trim()).filter(Boolean);
  const p = blocks.find((b) => !b.startsWith('#'));
  return p ? p.replace(/\s*\n\s*/g, ' ') : '';
}

/** First H1 heading text ("# Title") in a body. */
function firstH1(body) {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : '';
}

function slugOf(relPath) { return path.basename(relPath, '.md'); }

/** Maps "brain/memory/x/y.md" -> {title, description} from MEMORY.md's own bullet lines. */
function parseMemoryIndex() {
  let raw;
  try { raw = fs.readFileSync(PATHS.MEMORY_INDEX, 'utf8'); } catch { return new Map(); }
  const map = new Map();
  const re = /^-\s*\[([^\]]+)\]\(([^)]+)\)\s*—\s*(.*)$/gm;
  let m;
  while ((m = re.exec(raw))) map.set(m[2].trim(), { title: m[1].trim(), description: m[3].trim() });
  return map;
}

/** Every memory file under brain/memory/** whose frontmatter carries pin: true, unless it is archived or superseded. */
function findPinned() {
  const out = [];
  for (const type of ['user', 'feedback', 'reference', 'projects']) {
    const dir = path.join(PATHS.MEMORY_DIR, type);
    for (const f of listMdFiles(dir)) {
      const fm = readFrontmatter(path.join(dir, f));
      // A pin outlives an archive (brain-hub D5): Restore brings the rule back pinned, and until then it stays out.
      if (fm.pin === 'true' && !/status\/(archived|superseded)\b/.test(fm.tags || '')) out.push(`brain/memory/${type}/${f}`);
    }
  }
  return out;
}

/** Project memories tagged status/active, newest first by `updated` (else `created`); ties keep file-name order. */
function findActiveProjects() {
  const dir = path.join(PATHS.MEMORY_DIR, 'projects');
  const out = [];
  for (const f of listMdFiles(dir)) {
    const fm = readFrontmatter(path.join(dir, f));
    if (fm.tags && fm.tags.includes('status/active')) {
      out.push({ rel: `brain/memory/projects/${f}`, at: String(fm.updated || fm.created || '') });
    }
  }
  // Array.prototype.sort is stable, so equal dates stay in listMdFiles' name order.
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).map((p) => p.rel);
}

function bulletFor(rel, memIndex) {
  const e = memIndex.get(rel);
  if (!e) return `- **${slugOf(rel)}** — (no MEMORY.md entry)`;
  return `- **${e.title}** — ${clampToChars(e.description, BULLET_DESC_CHARS)}`;
}

function renderWho() {
  const para = firstParagraph(readBody(path.join(PATHS.MEMORY_DIR, 'user', 'profile.md')));
  return para || '_profile not found_';
}

function renderCriticalRules(memIndex) {
  const pinned = findPinned();
  return pinned.length ? pinned.map((rel) => bulletFor(rel, memIndex)).join('\n') : '_none pinned_';
}

/** `shown` is a newest-first prefix of the active projects; `omitted` counts the older ones the budget left out. */
function renderActiveContext(memIndex, shown, omitted) {
  const lines = shown.map((rel) => bulletFor(rel, memIndex));
  if (omitted) {
    const noun = `active project${omitted === 1 ? '' : 's'}`;
    lines.push(`- …and ${omitted} ${shown.length ? 'older ' : ''}${noun}: \`brain/_index/MOC-projects.md\``);
  }
  return lines.length ? lines.join('\n') : '_no active projects_';
}

/** Regex-lifts the "## Last Session" block (heading through EOF or next "## ") verbatim. */
function extractLastSession(brainMdContent) {
  const m = brainMdContent.match(/## Last Session[\s\S]*?(?=\n## |$)/);
  return m ? m[0].trim() : '## Last Session\n\n_none yet_';
}

function readExistingBrainMeta() {
  let raw = '';
  try { raw = fs.readFileSync(PATHS.BRAIN_MD, 'utf8'); } catch { /* first-ever compile */ }
  const fm = readFrontmatter(PATHS.BRAIN_MD);
  return {
    tags: fm.tags || '[brain/bootstrap, status/active]',
    lastSession: extractLastSession(raw),
  };
}

/**
 * Trims `text` to at most `maxChars`, preferring a word boundary, and marks the
 * cut with an ellipsis. Works in chars rather than tokens because the vault's
 * heuristic is ceil(chars/4): composing the document with a block of length N
 * adds exactly N chars, so a char ceiling converts to the token budget without
 * rounding slack.
 */
function clampToChars(text, maxChars) {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars - 1); // 1 char reserved for the ellipsis
  const wordBreak = cut.lastIndexOf(' ');
  return (wordBreak > maxChars * 0.6 ? cut.slice(0, wordBreak) : cut).trimEnd() + '…';
}

function composeBrainMd(meta, memIndex, lastSession, shown, omitted) {
  const lines = [];
  lines.push('---');
  lines.push('type: index');
  lines.push(`tags: ${meta.tags}`);
  lines.push('generatedBy: build-brain-md.js');
  lines.push(`generatedAt: ${new Date().toISOString()}`);
  lines.push(`ttl: ${TTL}`);
  lines.push(`updated: ${todayIso()}`);
  lines.push('---');
  lines.push('');
  lines.push('# BRAIN');
  lines.push('');
  lines.push(`> Auto-injected on the first turn of every session. Keep ≤${BUDGET} tokens — pointers, not content.`);
  lines.push('');
  lines.push('## Who');
  lines.push(renderWho());
  lines.push('');
  lines.push('## Critical rules');
  lines.push(renderCriticalRules(memIndex));
  lines.push('');
  lines.push('## Active context');
  lines.push(renderActiveContext(memIndex, shown, omitted));
  lines.push('');
  lines.push('## Quick links');
  lines.push(QUICK_LINKS);
  lines.push('');
  lines.push(lastSession);
  lines.push('');
  return lines.join('\n');
}

function writeAtomic(absPath, content) {
  fsx.writeAtomic(absPath, content); // a temp name of its own (lib/fsx.js), never a shared `<file>.tmp`
}

/** Replaces (or, if absent, appends) ONLY the "## Manual index" section of a MOC body. */
function upsertManualIndex(content, bulletsBody) {
  const re = /## Manual index[\s\S]*?(?=\n## |$)/;
  const block = `## Manual index\n${bulletsBody}\n`;
  if (re.test(content)) return content.replace(re, block).replace(/\n{3,}/g, '\n\n');
  const sep = content.endsWith('\n') ? '\n' : '\n\n';
  return `${content}${sep}${block}`;
}

/** Strips any prior contract keys from the frontmatter block, then appends fresh ones. */
function addContractFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return content; // no frontmatter block — leave untouched
  const kept = m[1].split(/\r?\n/).filter((l) => !/^(generatedBy|generatedAt|ttl|updated):/.test(l));
  const inner = [...kept, `generatedBy: build-brain-md.js`, `generatedAt: ${new Date().toISOString()}`, `ttl: ${TTL}`, `updated: ${todayIso()}`].join('\n');
  return content.slice(0, m.index) + '---\n' + inner + '\n---' + content.slice(m.index + m[0].length);
}

function regenMoc(relPath, bullets) {
  const abs = path.join(PATHS.VAULT, relPath);
  let content;
  try { content = fs.readFileSync(abs, 'utf8'); } catch { return null; }
  return { abs, content: addContractFrontmatter(upsertManualIndex(content, bullets || '_(none)_')) };
}

async function buildBrainMd({ report }) {
  const memIndex = parseMemoryIndex();
  const meta = readExistingBrainMeta();

  // Reference / projects MOCs: from MEMORY.md, filtered by folder.
  const byFolder = (prefix) => [...memIndex.entries()]
    .filter(([rel]) => rel.startsWith(prefix))
    .map(([rel, e]) => `- [[${slugOf(rel)}]] — ${e.description}`).join('\n');
  // Patterns MOC: from brain/patterns/*.md H1 titles directly (not MEMORY.md) —
  // see report for the dataview-root verification this mirrors.
  const patternBullets = listMdFiles(PATHS.PATTERNS)
    .map((f) => `- [[${slugOf(f)}]] — ${firstH1(readBody(path.join(PATHS.PATTERNS, f))) || slugOf(f)}`)
    .join('\n');

  const mocs = [
    regenMoc('brain/_index/MOC-reference.md', byFolder('brain/memory/reference/')),
    regenMoc('brain/_index/MOC-projects.md', byFolder('brain/memory/projects/')),
    regenMoc('brain/_index/MOC-patterns.md', patternBullets),
  ].filter(Boolean);

  // MOCs are written BEFORE the token budget is enforced, and deliberately so:
  // their "## Manual index" content has nothing to do with BRAIN.md's 850-token
  // ceiling. Both writes used to sit behind the budget gate, so one oversized
  // pinned rule stranded all four artifacts at once and the Fix Queue's
  // "rebuild the compiled brain artifacts" action could never succeed. The run
  // ledger persists report.wrote even when the fn throws, so a partial run
  // still reports exactly which artifacts refreshed.
  const wrote = [];
  for (const moc of mocs) {
    writeAtomic(moc.abs, moc.content);
    wrote.push(path.relative(PATHS.VAULT, moc.abs).replace(/\\/g, '/'));
  }
  if (report) {
    report.wrote.push(...wrote);
    report.counts.mocsRegenerated = mocs.length;
  }

  // Two-pass budget. First compose with the borrowed "## Last Session" block
  // omitted to price the compiler-owned sections, then hand that block only the
  // headroom left over. Active projects give way first, oldest first, until the
  // Last Session floor fits; throwing is reserved for pinned rules alone not
  // fitting, the one overflow that needs a person to prune.
  const active = findActiveProjects();
  let shownCount = active.length;
  let fixed = composeBrainMd(meta, memIndex, '', active, 0);
  while (BUDGET * 4 - fixed.length < MIN_LAST_SESSION_CHARS && shownCount > 0) {
    shownCount--;
    fixed = composeBrainMd(meta, memIndex, '', active.slice(0, shownCount), active.length - shownCount);
  }
  const shown = active.slice(0, shownCount);
  const omitted = active.length - shownCount;
  const headroomChars = BUDGET * 4 - fixed.length;
  if (headroomChars < MIN_LAST_SESSION_CHARS) {
    throw new Error(
      `compiler sections leave ${headroomChars} chars for "## Last Session", need ` +
      `${MIN_LAST_SESSION_CHARS} (sections are ${estimateTokens(fixed)}/${BUDGET} tokens with every ` +
      'active project left out) — prune pinned rules');
  }

  // Compose and write under BRAIN.md's lock, with the Last Session as it is now: the Stop hook's summary takes the
  // same lock, and one that landed after readExistingBrainMeta() used to be overwritten by this compile (spec
  // 2026-09-24-locked-writers D4). The headroom above was priced without the block, so a newer one still fits.
  let current = meta.lastSession;
  let lastSession = '';
  let brainMdContent = '';
  fsx.withLockSync(PATHS.BRAIN_MD, () => {
    let raw = '';
    try { raw = fs.readFileSync(PATHS.BRAIN_MD, 'utf8'); } catch { /* first-ever compile */ }
    if (raw) current = extractLastSession(raw);
    lastSession = clampToChars(current, headroomChars);
    brainMdContent = composeBrainMd(meta, memIndex, lastSession, shown, omitted);
    fsx.writeAtomic(PATHS.BRAIN_MD, brainMdContent);
  }, { timeoutMs: 5000 });
  const tokens = estimateTokens(brainMdContent);
  wrote.push('brain/_index/BRAIN.md');

  // What BRAIN.md was built from, by path (brain-hub D10): its bullets name titles, so the injection's usage rows and
  // the hub's Bootstrap read the sources here. Best effort: a failure here never fails the compile that just landed.
  try {
    const profile = 'brain/memory/user/profile.md';
    const pinned = findPinned();
    const sources = {
      schema: 1, builtAt: new Date().toISOString(), budget: BUDGET, tokens,
      sections: {
        who: { paths: fs.existsSync(path.join(PATHS.VAULT, profile)) ? [profile] : [], tokens: estimateTokens(renderWho()) },
        rules: { paths: pinned, tokens: estimateTokens(renderCriticalRules(memIndex)) },
        active: { paths: shown, omitted: active.slice(shownCount), tokens: estimateTokens(renderActiveContext(memIndex, shown, omitted)) },
        links: { tokens: estimateTokens(QUICK_LINKS) },
        lastSession: { tokens: estimateTokens(lastSession), clampedChars: current.length - lastSession.length },
      },
    };
    fsx.writeAtomic(path.join(PATHS.INDEX, 'brain-sources.json'), JSON.stringify(sources, null, 2) + '\n');
    wrote.push('brain/_index/brain-sources.json');
  } catch (e) {
    console.error('[build-brain-md] brain-sources.json not written:', e.message);
  }

  if (report) {
    report.wrote.push('brain/_index/BRAIN.md');
    report.counts.tokens = tokens;
    report.counts.pinnedRules = findPinned().length;
    report.counts.activeProjects = active.length;
    // BRAIN.md itself says how many projects it left out; the ledger keeps the count.
    report.counts.activeProjectsOmitted = omitted;
    // Surfaced rather than silent: a clamp means the Stop-hook summary is
    // outrunning the budget and BRAIN.md is showing a trimmed one.
    report.counts.lastSessionClampedChars = current.length - lastSession.length;
  }

  return { tokens, wrote, lastSessionClamped: lastSession !== current, projectsOmitted: omitted };
}

if (require.main === module) {
  withReport('build-brain-md', async (report) => {
    await buildBrainMd({ report });
  }).catch((e) => { console.error('[build-brain-md]', e.message); process.exit(1); });
}
module.exports = { buildBrainMd, BUDGET };
