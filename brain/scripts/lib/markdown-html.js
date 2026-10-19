'use strict';
/**
 * markdown-html.js — a small, dependency-free Markdown → HTML converter for the pages the runtime renders from vault
 * files (docs/design/specs/2026-09-22-proposal-pages-design.md D5). The subset: ATX headings, paragraphs, `-` `*`
 * `+` and `1.` lists nested by indentation, `**bold**`, `*em*`, `` `code` ``, fenced blocks (a `diff` fence colours its
 * `+` / `-` / `@@` lines), GFM tables, `>` quotes, `---` rules and `[text](url)` links.
 *
 * The source may carry text a duty copied from somewhere untrusted, so every text node is escaped, raw HTML shows as
 * text, and a link becomes an anchor only for http, https, file, agenticos (the Workbench app's links) and obsidian
 * (links written before the app) URLs or a relative path — any other scheme (javascript:, data:, vbscript:) renders as
 * its label.
 */

const LINK_SCHEMES = ['http:', 'https:', 'file:', 'agenticos:', 'obsidian:'];
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/;
const FENCE_RE = /^(\s*)(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** The href to emit for a link target, or null when it must stay text. */
function safeHref(url) {
  const u = String(url).trim();
  if (!u || u.startsWith('//')) return null;
  const scheme = /^([a-z][a-z0-9+.-]*:)/i.exec(u);
  if (!scheme) return u;                                   // relative path or #fragment
  return LINK_SCHEMES.includes(scheme[1].toLowerCase()) ? u : null;
}

/** Escapes text that may hold placeholders, then applies bold and emphasis. */
function emphasis(s) {
  return esc(s)
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=\S)([^\n]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/(^|[^*\w])\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?![*\w])/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^\s_](?:[^_\n]*?[^\s_])?)_(?![_\w])/g, '$1<em>$2</em>');
}

/** Inline spans. Code spans and links become placeholders first so emphasis can wrap a link (`**[x](y)**`). */
function inline(src) {
  const held = [];
  const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
  const restore = (s) => s.replace(/\u0000(\d+)\u0000/g, (_, i) => restore(held[Number(i)]));
  const text = String(src).replace(/\u0000/g, '')
    .replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${esc(code)}</code>`))
    .replace(/\[([^\]\n]+)\]\(\s*<?((?:[^()\s<>]|\([^()\s]*\))+)>?(?:\s+"[^"]*")?\s*\)/g, (_, label, url) => {
      const href = safeHref(url);
      return hold(href ? `<a href="${esc(href)}">${emphasis(label)}</a>` : emphasis(label));
    });
  return restore(emphasis(text));
}

const indentOf = (line) => /^\s*/.exec(line)[0].replace(/\t/g, '    ').length;
const isTableStart = (lines, i) => i + 1 < lines.length && lines[i].includes('|') && TABLE_SEP_RE.test(lines[i + 1]);

function isBlockStart(lines, i) {
  const l = lines[i];
  return FENCE_RE.test(l) || HEADING_RE.test(l) || HR_RE.test(l) || QUOTE_RE.test(l) || LIST_RE.test(l) || isTableStart(lines, i);
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function table(lines, i) {
  const head = splitRow(lines[i]);
  const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
  const cell = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c)}</${tag}>`;
  let j = i + 2;
  const rows = [];
  while (j < lines.length && lines[j].trim() && lines[j].includes('|')) rows.push(splitRow(lines[j++]));
  const body = rows.map((r) => `<tr>${head.map((_, k) => cell('td', r[k] ?? '', k)).join('')}</tr>`).join('\n');
  return [`<div class="table"><table>\n<thead><tr>${head.map((c, k) => cell('th', c, k)).join('')}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table></div>`, j];
}

function fence(lines, i) {
  const open = FENCE_RE.exec(lines[i]);
  const marker = open[2];
  const lang = open[3].toLowerCase();
  const close = new RegExp(`^\\s*\\${marker[0]}{${marker.length},}\\s*$`);
  const code = [];
  let j = i + 1;
  while (j < lines.length && !close.test(lines[j])) code.push(lines[j++]);
  const body = lang === 'diff'
    ? code.map((l) => (l.startsWith('+') ? `<span class="add">${esc(l)}</span>` : l.startsWith('-') ? `<span class="del">${esc(l)}</span>` : l.startsWith('@@') ? `<span class="hunk">${esc(l)}</span>` : esc(l))).join('\n')
    : esc(code.join('\n'));
  return [`<pre${lang ? ` class="lang-${esc(lang)}"` : ''}><code>${body}</code></pre>`, Math.min(j + 1, lines.length)];
}

/** One list; items at the first item's indent are siblings, deeper lines belong to the item above (nested lists included). */
function list(lines, i) {
  const first = LIST_RE.exec(lines[i]);
  const base = indentOf(first[1]);
  const ordered = /\d/.test(first[2]);
  const items = [];
  let offset = 0;
  let loose = false;
  let j = i;
  while (j < lines.length) {
    const line = lines[j];
    const m = LIST_RE.exec(line);
    if (m && indentOf(m[1]) === base && /\d/.test(m[2]) === ordered) {
      offset = m[1].length + m[2].length + Math.min(m[3].length, 4);
      items.push([m[4]]);
      j++;
      continue;
    }
    if (!line.trim()) {
      let k = j + 1;
      while (k < lines.length && !lines[k].trim()) k++;
      if (k >= lines.length) break;
      const next = LIST_RE.exec(lines[k]);
      if ((next && indentOf(next[1]) === base && /\d/.test(next[2]) === ordered) || indentOf(lines[k]) > base) {
        loose = true;
        for (; j < k; j++) items[items.length - 1].push('');
        continue;
      }
      break;
    }
    if (indentOf(line) > base) { items[items.length - 1].push(line.slice(Math.min(/^\s*/.exec(line)[0].length, offset))); j++; continue; }
    if (!m && !isBlockStart(lines, j) && items[items.length - 1].at(-1) !== '') { items[items.length - 1].push(line.trim()); j++; continue; }
    break;
  }
  const tag = ordered ? 'ol' : 'ul';
  const n = ordered ? parseInt(first[2], 10) : 1;
  const lis = items.map((it) => `<li>${blocks(it, { tight: !loose })}</li>`).join('\n');
  return [`<${tag}${n !== 1 ? ` start="${n}"` : ''}>\n${lis}\n</${tag}>`, j];
}

/** Block structure of `lines`. In a tight list item, paragraphs are emitted without <p>. */
function blocks(lines, { tight = false } = {}) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let r;
    if (FENCE_RE.test(line)) r = fence(lines, i);
    else if (HEADING_RE.test(line)) { const h = HEADING_RE.exec(line); r = [`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`, i + 1]; }
    else if (HR_RE.test(line)) r = ['<hr>', i + 1];
    else if (isTableStart(lines, i)) r = table(lines, i);
    else if (QUOTE_RE.test(line)) {
      const q = [];
      let j = i;
      while (j < lines.length && QUOTE_RE.test(lines[j])) q.push(QUOTE_RE.exec(lines[j++])[1]);
      r = [`<blockquote>${blocks(q)}</blockquote>`, j];
    } else if (LIST_RE.test(line)) r = list(lines, i);
    else {
      const para = [line.trim()];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() && !isBlockStart(lines, j)) para.push(lines[j++].trim());
      const html = para.map(inline).join('<br>\n');
      r = [tight ? html : `<p>${html}</p>`, j];
    }
    out.push(r[0]);
    i = r[1];
  }
  return out.join('\n');
}

/** Markdown text → an HTML fragment. */
function toHtml(md) {
  return blocks(String(md ?? '').replace(/\r\n?/g, '\n').split('\n'));
}

module.exports = { toHtml, inline, esc, safeHref };
