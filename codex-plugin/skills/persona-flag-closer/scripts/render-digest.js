#!/usr/bin/env node
// Render flag-closer review JSON (output of recheck.js) as a self-contained HTML digest.
// Usage: node render-digest.js <review.json> > digest.html
const fs = require('fs');
const { verbsFor } = require('./collect.js');

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function ageDays(filed) {
  const d = Date.parse(filed);
  return isNaN(d) ? '?' : Math.floor((Date.now() - d) / 86400000);
}
const BADGE = { 'STILL-VALID': 'ok', 'STALE': 'stale', 'RECIPE-ERROR': 'err', 'NO-RECIPE': 'warn' };
function premiseSummary(ps) {
  const v = ps.filter(p => p.status === 'VERIFIED').length;
  return `${v} VERIFIED / ${ps.length - v} ASSUMED`;
}

function render(r) {
  const rows = r.proposals.map(p => `<tr>
    <td><code>${esc(p.slug)}</code><div class="sub">${esc(p.target)}${p.surface ? ` · surface: ${esc(p.surface)}` : ''}</div></td>
    <td>${esc(p.kind || 'self')}<div class="sub">${esc((p.verbs || verbsFor(p.kind || 'self')).label)}</div></td>
    <td>${esc(p.filed)}<div class="sub">${ageDays(p.filed)}d old</div></td>
    <td><span class="badge ${BADGE[p.verdict] || 'warn'}">${esc(p.verdict)}</span>${p.lint.length ? `<div class="sub">lint: ${esc(p.lint.join('; '))}</div>` : ''}</td>
    <td>${p.premises.length ? esc(premiseSummary(p.premises)) : '<span class="sub">none</span>'}</td>
  </tr>`).join('\n');
  const flags = r.flags.map(f => `<li>${esc(f.text)}</li>`).join('\n') || '<li class="sub">none</li>';
  const logs = r.logFindings.map(l =>
    `<h3>${esc(l.log)}</h3><pre>${esc(l.lines.join('\n'))}</pre>`).join('\n')
    || '<p class="sub">No new error-log lines since last review.</p>';
  return `<title>Persona Flag Review</title>
<style>
:root{--bg:#f7f7f5;--card:#ffffff;--ink:#1a1a1a;--sub:#6b6b6b;--line:#e2e2de;--ok:#2e7d32;--warn:#ef6c00;--err:#c62828;--stale:#757575}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#161618;--card:#1f1f23;--ink:#ececec;--sub:#9a9aa2;--line:#33333a}}
:root[data-theme="dark"]{--bg:#161618;--card:#1f1f23;--ink:#ececec;--sub:#9a9aa2;--line:#33333a}
body{background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem}
h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:2rem}.sub{color:var(--sub);font-size:.85em}
table{width:100%;border-collapse:collapse;background:var(--card)}
td,th{border:1px solid var(--line);padding:.5rem .6rem;text-align:left;vertical-align:top}
.badge{padding:.1rem .5rem;border-radius:1rem;color:#fff;font-size:.8em;white-space:nowrap}
.badge.ok{background:var(--ok)}.badge.warn{background:var(--warn)}.badge.err{background:var(--err)}.badge.stale{background:var(--stale)}
pre{background:var(--card);border:1px solid var(--line);padding:.75rem;overflow-x:auto;font-size:.8em}
</style>
<h1>Persona Flag Review</h1>
<p class="sub">Generated ${esc(r.generated)} · pending-set hash <code>${esc((r.pendingHash || '').slice(0, 12))}</code> · nothing applies without your decision</p>
<h2>Pending proposals (${r.proposals.length})</h2>
${r.proposals.length ? `<div style="overflow-x:auto"><table><tr><th>Proposal</th><th>Kind · decision</th><th>Filed</th><th>Recheck verdict</th><th>Premises</th></tr>${rows}</table></div>` : '<p class="sub">none</p>'}
<h2>STATE.md flags (${r.flags.length})</h2><ul>${flags}</ul>
<h2>New silent failures</h2>${logs}`;
}

if (require.main === module) {
  const review = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  process.stdout.write(render(review));
}
module.exports = { render, esc };
