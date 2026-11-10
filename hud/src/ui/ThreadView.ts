import type { HostCatalogHost } from "../host";
import type { SessionHost } from "../data/aosConfig";
import { choiceText, countsText, doneLine, relPath, toolResultText, type PlanItem, type ThreadRow } from "../data/agentSessions";

/** A file's current diff opened from a tool or patch line; null while it is read. */
export type FileDiff = { text: string; truncated: boolean; error: string | null } | null;

/** A file's `+added −removed` counts against HEAD, as the repository status reports them. */
export type FileCountsValue = { added: number | null; removed: number | null } | null;

/** A file's diff in a thread shows this many lines; the Review drawer's shows them all. */
export const DIFF_LINES = 400;
/** Claude Code's word for each change a Codex patch reports. */
const PATCH_VERB: Record<string, string> = { add: "Write", delete: "Delete", update: "Update" };
/** What a screen reader hears before each plan item: the box alone says it only by sight. */
const PLAN_STATE: Record<PlanItem["status"], string> = { done: "Done: ", active: "In progress: ", pending: "To do: " };

/** What the rows need to know of their thread. */
export interface ThreadViewContext {
  host: SessionHost;
  entry: HostCatalogHost | null;
  root: string | null;
  choices: Map<number, { model: string | null; effort: string | null }>;
}

export interface ThreadViewOptions {
  /** Draws the agent's markdown text into `el`. */
  md(el: HTMLElement, text: string): void;
  /** Which tool and patch rows are open; the caller keeps it, so it survives each render. */
  expanded?: Set<string>;
  /** The path a file's diff is read by (relative to its repository), or null when it has none. */
  diffPath?(file: string): string | null;
  /** The file's `+/−` counts, shown on its edit line. */
  fileCounts?(file: string): FileCountsValue;
  /** The file's cached diff: undefined (never read; the getter starts the read), null (reading) or the diff. */
  fileDiff?(file: string): FileDiff | undefined;
  /** A tool or patch line was clicked: the caller flips `expanded`, starts any diff read and renders again. */
  onToggle?(key: string, file: string | null): void;
}

/**
 * The conversation rows of a thread, drawn as the Sessions reader draws them (prompts, agent text, `⏺ Verb(target)` tool
 * lines with their `⎿` result, patches, the plan, model changes, computer lines, errors, a footer per turn). Sessions and
 * the Code tab's chat both render through it. `render` appends the rows to the parent; the caller empties it first and
 * adds anything of its own (notes, the working line) around them.
 */
export class ThreadView {
  constructor(private readonly parent: HTMLElement, private readonly o: ThreadViewOptions) {}

  render(rows: ThreadRow[], ctx: ThreadViewContext): void {
    for (const row of rows) this.renderRow(this.parent, row, ctx);
  }

  destroy(): void {
    this.parent.empty();
  }

  private open(key: string): boolean {
    return this.o.expanded?.has(key) ?? false;
  }

  private renderRow(el: HTMLElement, r: ThreadRow, ctx: ThreadViewContext): void {
    if (r.kind === "prompt") {
      el.createDiv({ cls: "aos-ss-prompt" }).createDiv({ cls: "aos-ss-bubble", text: r.text });
    } else if (r.kind === "text") {
      const body = el.createDiv({ cls: "aos-ss-text" });
      this.o.md(body, r.text);
    } else if (r.kind === "tool") {
      this.renderTool(el, r);
    } else if (r.kind === "patch") {
      this.renderPatch(el, r, ctx);
    } else if (r.kind === "plan") {
      const card = el.createDiv({ cls: "aos-ss-plan" });
      card.createDiv({ cls: "aos-ss-planhead", text: "Plan" });
      const list = card.createEl("ul", { cls: "aos-ss-planlist" });
      for (const item of r.items) {
        const li = list.createEl("li", { cls: `aos-ss-planitem is-${item.status}`, attr: { "data-status": item.status } });
        li.createSpan({ cls: "aos-ss-planbox", text: item.status === "done" ? "☒" : "☐", attr: { "aria-hidden": "true" } });
        const text = li.createSpan({ cls: "aos-ss-plantext" });
        text.createSpan({ cls: "aos-ss-sronly", text: PLAN_STATE[item.status] });
        text.appendText(item.text);
      }
    } else if (r.kind === "change") {
      el.createDiv({ cls: "aos-ss-turnchange", attr: { "data-turn": String(r.turn) } }).createSpan({ cls: "aos-ss-turnchangetext", text: r.text });
    } else if (r.kind === "computer") {
      // agent-computer D6, D21, D35: what the Computer pane's activity log says, for this thread's agent.
      const line = el.createDiv({ cls: "aos-ss-computer", attr: { "data-turn": String(r.turn) } });
      line.createSpan({ cls: "aos-ss-computerlabel", text: "Computer" });
      line.createSpan({ cls: "aos-ss-computertext", text: r.text });
    } else if (r.kind === "error") {
      el.createDiv({ cls: "aos-ss-error", text: r.message });
    } else {
      const c = ctx.choices.get(r.turn);
      const choice = c ? choiceText(ctx.host, ctx.entry, c.model, c.effort) : null;
      el.createDiv({ cls: `aos-ss-done${r.ok ? "" : " is-failed"}`, text: doneLine(r, choice) });
    }
  }

  /** `⏺ Verb(target)` and its `⎿` result; open, the full input and result and, for an edit, the file's diff (U10). */
  private renderTool(el: HTMLElement, r: Extract<ThreadRow, { kind: "tool" }>): void {
    const tone = r.result === null ? "is-pending" : r.result.ok ? "is-ok" : "is-failed";
    const open = this.open(r.key);
    const box = el.createDiv({ cls: `aos-ss-tool ${tone}${open ? " is-open" : ""}`, attr: { "data-kind": r.tool.toolKind || "other", "data-verb": r.verb } });
    const file = r.tool.toolKind === "edit" && r.tool.filePath ? this.o.diffPath?.(r.tool.filePath) ?? null : null;
    this.renderLine(box, r.verb, r.target, open, `tool:${r.key}`, () => this.o.onToggle?.(r.key, file));
    const result = toolResultText(r, file ? this.o.fileCounts?.(file) ?? null : null);
    if (result !== null) this.renderResult(box, result, r.result?.ok === false);
    if (!open) return;
    const body = box.createDiv({ cls: "aos-ss-toolbody" });
    if (r.tool.summary) body.createEl("pre", { cls: "aos-ss-toolin", text: r.tool.summary });
    if (r.result) {
      body.createDiv({ cls: "aos-ss-toolstate", text: r.result.ok ? "Result" : "Failed" });
      if (r.result.summary) body.createEl("pre", { cls: "aos-ss-toolout", text: r.result.summary });
    } else body.createDiv({ cls: "aos-ss-toolstate", text: "No result yet" });
    if (file) this.renderFileDiff(body, file);
  }

  /** A Codex patch as Claude Code shows edits: a line per file with its +/−, each opening to the file's diff. */
  private renderPatch(el: HTMLElement, r: Extract<ThreadRow, { kind: "patch" }>, ctx: ThreadViewContext): void {
    const box = el.createDiv({ cls: "aos-ss-patch" });
    r.files.forEach((f, i) => {
      const key = `patch:${r.turn}:${i}:${f.path}`;
      const open = this.open(key);
      const file = f.path ? this.o.diffPath?.(f.path) ?? null : null;
      const item = box.createDiv({ cls: `aos-ss-patchfile is-ok${open ? " is-open" : ""}`, attr: { "data-file": file ?? f.path, "data-change": f.change } });
      this.renderLine(item, PATCH_VERB[f.change] ?? "Update", relPath(f.path, ctx.root), open, key, () => this.o.onToggle?.(key, file));
      const counts = file ? this.o.fileCounts?.(file) ?? null : null;
      const c = counts ? countsText(counts) : "";
      this.renderResult(item, c ? `${c} · open to see the file's diff` : "Done", false);
      if (open && file) this.renderFileDiff(item.createDiv({ cls: "aos-ss-toolbody" }), file);
    });
  }

  private renderLine(box: HTMLElement, verb: string, target: string, open: boolean, key: string, toggle: () => void): void {
    const line = box.createEl("button", { cls: "aos-ss-toolline", attr: { type: "button", "aria-expanded": String(open), "data-focus": key } });
    line.createSpan({ cls: "aos-ss-verb", text: verb });
    if (target) line.createSpan({ cls: "aos-ss-target", text: `(${target})` });
    line.addEventListener("click", toggle);
  }

  /** The `⎿` line; an edit's `+a −b` in their colours. */
  private renderResult(box: HTMLElement, text: string, failed: boolean): void {
    const out = box.createDiv({ cls: `aos-ss-toolresult${failed ? " is-failed" : ""}` });
    const m = /^(\+\d+) (−\d+)( · .*)$/.exec(text);
    if (!m) { out.setText(text); return; }
    out.createSpan({ cls: "aos-ss-plus", text: m[1] });
    out.appendText(" ");
    out.createSpan({ cls: "aos-ss-minus", text: m[2] });
    out.appendText(m[3]);
  }

  /** The file's diff against HEAD now (git:diff), the same for both hosts: Codex names only the files it changed. */
  private renderFileDiff(parent: HTMLElement, file: string): void {
    const wrap = parent.createDiv({ cls: "aos-ss-filediff" });
    const d = this.o.fileDiff?.(file);   // the getter starts a read when there is none (read again after a turn or a commit)
    if (!d) { wrap.createDiv({ cls: "aos-ss-note", text: "Reading the file's diff…" }); return; }
    if (d.error) { wrap.createDiv({ cls: "aos-ss-error", text: d.error }); return; }
    if (!d.text.trim()) { wrap.createDiv({ cls: "aos-ss-note", text: "The file has no changes against HEAD." }); return; }
    renderDiff(wrap, d.text, d.truncated, DIFF_LINES);
  }
}

/** A unified diff, a line each in its colour; `max` caps the lines drawn. */
export function renderDiff(parent: HTMLElement, text: string, truncated: boolean, max = Infinity): void {
  const lines = text.replace(/\n$/, "").split("\n");
  const pre = parent.createEl("pre", { cls: "aos-ss-diff" });
  for (const line of lines.slice(0, max)) {
    const kind = /^(diff |index |--- |\+\+\+ )/.test(line) ? " is-meta" : line.startsWith("@@") ? " is-hunk" : line.startsWith("+") ? " is-add" : line.startsWith("-") ? " is-del" : "";
    pre.createSpan({ cls: `aos-ss-diffline${kind}`, text: line || " " });
  }
  if (lines.length > max) parent.createDiv({ cls: "aos-ss-note", text: `The first ${max} of ${lines.length} lines; Review changes shows them all.` });
  if (truncated) parent.createDiv({ cls: "aos-ss-note", text: "The diff is longer than this; only its first 2 MB are shown." });
}
