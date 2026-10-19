// todos.ts — the To-Do tab's model of <vault>/TODO.md (spec 2026-09-22-todo-and-proposals-tabs D1–D4, §4.3).
// Pure: file text in, items or new file text out. Items use Obsidian Tasks-plugin syntax — 📅 due, ✅ done,
// 🔺 ⏫ 🔼 🔽 ⏬ priority, #tags — so the file stays readable by that plugin. Every edit names its item by the
// exact raw line it read; if that line is gone (the file changed underneath, e.g. through /todo) the edit
// throws StaleTodoError and the caller re-reads instead of guessing. Lines this module does not touch are
// written back byte for byte.

export const TODO_PATH = "TODO.md";
export const TODO_TEMPLATE = [
  "# To-Do",
  "",
  "Written by the Workbench To-Do tab and `/todo`. Tasks-plugin syntax: 📅 due date, ⏫ 🔼 🔽 priority, #tags.",
  "Ticking an item moves it to Done with its completion date (✅).",
  "",
  "## Open",
  "",
  "## Done",
  "",
].join("\n");

export type Priority = "highest" | "high" | "medium" | "low" | "lowest";
export const PRIORITY_EMOJI: Record<Priority, string> = { highest: "🔺", high: "⏫", medium: "🔼", low: "🔽", lowest: "⏬" };
/** Tasks-plugin order: no priority sorts between medium and low. */
const PRIORITY_RANK: Record<Priority | "none", number> = { highest: 0, high: 1, medium: 2, none: 3, low: 4, lowest: 5 };
const EMOJI_PRIORITY: Record<string, Priority> = Object.fromEntries(
  Object.entries(PRIORITY_EMOJI).map(([p, e]) => [e, p as Priority]),
);
const PRIORITY_RE = /\s*(?:🔺|⏫|🔼|🔽|⏬)️?/gu;
const DUE_RE = /\s*📅️?\s*(\d{4}-\d{2}-\d{2})/u;
const DONE_RE = /\s*✅️?\s*(\d{4}-\d{2}-\d{2})/u;
const TAG_RE = /(^|\s)#([^\s#]*[^\s#\d][^\s#]*)/gu;
const ITEM_RE = /^([-*]) \[([ xX])\] ?(.*)$/;

export interface Todo {
  raw: string;              // the item's line exactly as read — its identity for edits
  children: string[];       // indented lines under it; they travel with it
  line: number;             // 0-based index of `raw` in the file
  done: boolean;
  body: string;             // everything after the checkbox, tokens included
  text: string;             // body without dates, priority and tags
  due: string | null;       // YYYY-MM-DD
  doneOn: string | null;    // YYYY-MM-DD
  priority: Priority | null;
  tags: string[];           // without the leading #
  section: string | null;   // the H2 it sits under ("Open", "Done", …)
}

export class StaleTodoError extends Error {
  constructor(raw: string) { super(`TODO.md changed: "${raw}" is no longer there`); this.name = "StaleTodoError"; }
}

/** Local calendar day as YYYY-MM-DD. */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return localDay(new Date(y, m - 1, d + n));
}

/** Reads the tokens out of an item body. */
export function parseBody(body: string): Pick<Todo, "text" | "due" | "doneOn" | "priority" | "tags"> {
  const due = DUE_RE.exec(body)?.[1] ?? null;
  const doneOn = DONE_RE.exec(body)?.[1] ?? null;
  const prio = /(🔺|⏫|🔼|🔽|⏬)/u.exec(body)?.[1];
  const tags: string[] = [];
  for (const m of body.matchAll(TAG_RE)) tags.push(m[2]);
  const text = body.replace(DUE_RE, "").replace(DONE_RE, "").replace(PRIORITY_RE, "").replace(TAG_RE, "$1")
    .replace(/\s+/g, " ").trim();
  return { text, due, doneOn, priority: prio ? EMOJI_PRIORITY[prio] : null, tags };
}

/** Composes a body in the order the tab writes it: text, priority, due, tags. */
export function composeBody(t: { text: string; priority?: Priority | null; due?: string | null; tags?: string[] }): string {
  const parts = [t.text.trim()];
  if (t.priority) parts.push(PRIORITY_EMOJI[t.priority]);
  if (t.due) parts.push(`📅 ${t.due}`);
  for (const tag of t.tags ?? []) parts.push(`#${tag.replace(/^#/, "")}`);
  return parts.filter(Boolean).join(" ");
}

/** Replaces (or removes, with null) the priority token, leaving the rest of the body as written. */
export function withPriority(body: string, p: Priority | null): string {
  const rest = body.replace(PRIORITY_RE, "").trim();
  if (!p) return rest;
  const due = DUE_RE.exec(rest);
  // Keep Tasks order: the priority goes before the first date when there is one.
  return due ? `${rest.slice(0, due.index).trimEnd()} ${PRIORITY_EMOJI[p]}${rest.slice(due.index)}` : `${rest} ${PRIORITY_EMOJI[p]}`;
}

/** Replaces (or removes, with null) the 📅 due date. */
export function withDue(body: string, day: string | null): string {
  const rest = body.replace(DUE_RE, "").trim();
  if (!day) return rest;
  const tag = /(^|\s)#[^\s#]/u.exec(rest);
  // Dates go before trailing tags so the Tasks plugin still reads them.
  if (tag && /^(\s*#[^\s#]+)+\s*$/u.test(rest.slice(tag.index))) {
    return `${rest.slice(0, tag.index).trimEnd()} 📅 ${day}${rest.slice(tag.index)}`;
  }
  return `${rest} 📅 ${day}`;
}

function split(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
const join = (lines: string[]) => `${lines.join("\n")}\n`;
const isChild = (l: string) => /^[ \t]+\S/.test(l);

export function parseTodos(text: string): Todo[] {
  const lines = split(text);
  const out: Todo[] = [];
  let section: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const h = /^## (.+?)\s*$/.exec(lines[i]);
    if (h) { section = h[1]; continue; }
    const m = ITEM_RE.exec(lines[i]);
    if (!m) continue;
    const children: string[] = [];
    while (i + 1 < lines.length && isChild(lines[i + 1])) children.push(lines[++i]);
    const body = m[3];
    out.push({ raw: lines[i - children.length], children, line: i - children.length, done: m[2] !== " ", body, section, ...parseBody(body) });
  }
  return out;
}

/** Index of the `## <name>` heading, or -1. */
function heading(lines: string[], name: string): number {
  return lines.findIndex((l) => new RegExp(`^## ${name}\\s*$`).test(l));
}

/** Makes sure `## <name>` exists (appended at the end when missing) and returns its index. */
function ensureSection(lines: string[], name: string): number {
  const at = heading(lines, name);
  if (at >= 0) return at;
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.length) lines.push("");
  lines.push(`## ${name}`);
  return lines.length - 1;
}

/** Where a new block goes: after the last item block of the section, or right under its heading. */
function sectionEnd(lines: string[], at: number): number {
  let end = at + 1;
  for (let i = at + 1; i < lines.length && !/^## /.test(lines[i]); i++) {
    if (ITEM_RE.test(lines[i]) || (isChild(lines[i]) && i === end)) end = i + 1;
  }
  return end;
}

function locate(lines: string[], raw: string): { at: number; len: number } {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== raw || !ITEM_RE.test(raw)) continue;
    let len = 1;
    while (i + len < lines.length && isChild(lines[i + len])) len++;
    return { at: i, len };
  }
  throw new StaleTodoError(raw);
}

/** Appends `- [ ] <body>` to the end of ## Open (creating the file from the template when empty). */
export function addTodo(text: string | null, body: string): string {
  const clean = body.replace(/[\r\n]+/g, " ").trim();
  if (!clean) throw new Error("empty todo");
  const lines = split(text && text.trim() ? text : TODO_TEMPLATE);
  const at = ensureSection(lines, "Open");
  lines.splice(sectionEnd(lines, at), 0, `- [ ] ${clean}`);
  return join(lines);
}

/** Ticks an open item (adds ✅ today and moves it to the top of ## Done) or un-ticks a done one (back to the end of ## Open). */
export function toggleTodo(text: string, raw: string, today: string): string {
  const lines = split(text);
  const { at, len } = locate(lines, raw);
  const block = lines.splice(at, len);
  const m = ITEM_RE.exec(block[0])!;
  const done = m[2] !== " ";
  if (done) {
    block[0] = `${m[1]} [ ] ${m[3].replace(DONE_RE, "").trimEnd()}`;
    const open = ensureSection(lines, "Open");
    lines.splice(sectionEnd(lines, open), 0, ...block);
  } else {
    block[0] = `${m[1]} [x] ${m[3].replace(DONE_RE, "").trimEnd()} ✅ ${today}`;
    const dn = ensureSection(lines, "Done");
    lines.splice(dn + 1, 0, ...block);
  }
  return join(lines);
}

/** Rewrites an item's body in place; the checkbox state and children are kept. */
export function editTodo(text: string, raw: string, body: string): string {
  const clean = body.replace(/[\r\n]+/g, " ").trim();
  if (!clean) throw new Error("empty todo");
  const lines = split(text);
  const { at } = locate(lines, raw);
  const m = ITEM_RE.exec(lines[at])!;
  lines[at] = `${m[1]} [${m[2]}] ${clean}`;
  return join(lines);
}

/** Deletes an item and its children. */
export function removeTodo(text: string, raw: string): string {
  const lines = split(text);
  const { at, len } = locate(lines, raw);
  lines.splice(at, len);
  return join(lines);
}

// ── grouping ─────────────────────────────────────────────────────────────────

export type GroupId = "overdue" | "today" | "upcoming" | "someday";
export const GROUPS: { id: GroupId; label: string }[] = [
  { id: "overdue", label: "OVERDUE" }, { id: "today", label: "TODAY" },
  { id: "upcoming", label: "UPCOMING" }, { id: "someday", label: "SOMEDAY" },
];

function byPriority(a: Todo, b: Todo): number {
  return (PRIORITY_RANK[a.priority ?? "none"] - PRIORITY_RANK[b.priority ?? "none"])
    || (a.due ?? "9999").localeCompare(b.due ?? "9999")
    || (a.line - b.line);
}

/** Open items bucketed by due date against `today`, each bucket priority-first. */
export function groupTodos(items: Todo[], today: string): Record<GroupId, Todo[]> {
  const g: Record<GroupId, Todo[]> = { overdue: [], today: [], upcoming: [], someday: [] };
  for (const t of items) {
    if (t.done) continue;
    if (!t.due) g.someday.push(t);
    else if (t.due < today) g.overdue.push(t);
    else if (t.due === today) g.today.push(t);
    else g.upcoming.push(t);
  }
  for (const k of Object.keys(g) as GroupId[]) g[k].sort(byPriority);
  return g;
}

/** Items ticked in the last 7 days (today included), newest first. */
export function doneThisWeek(items: Todo[], today: string): Todo[] {
  const since = addDays(today, -6);
  return items.filter((t) => t.done && t.doneOn && t.doneOn >= since && t.doneOn <= today)
    .sort((a, b) => b.doneOn!.localeCompare(a.doneOn!) || a.line - b.line);
}

/** Tags on open items, sorted. */
export function openTags(items: Todo[]): string[] {
  return [...new Set(items.filter((t) => !t.done).flatMap((t) => t.tags))].sort();
}

/** The rail badge: open items overdue or due today. */
export function todoBadgeCount(text: string | null, today: string): number {
  if (!text) return 0;
  const g = groupTodos(parseTodos(text), today);
  return g.overdue.length + g.today.length;
}
