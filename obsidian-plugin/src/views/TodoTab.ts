import { Notice, TFile } from "obsidian";
import type { TAbstractFile } from "obsidian";
import type AgenticOSPlugin from "../../main";
import type { WorkbenchView } from "./WorkbenchView";
import { ConfirmModal } from "../ui/ConfirmModal";
import { invocationHint, readAgenticosJson } from "../data/aosConfig";
import {
  TODO_PATH, TODO_TEMPLATE, GROUPS, Priority, Todo, StaleTodoError, parseTodos, groupTodos, doneThisWeek, openTags, localDay, addDays,
  addTodo, toggleTodo, editTodo, removeTodo, withPriority, withDue, todoBadgeCount,
} from "../data/todos";
import { adapterOf, applyTodoEdit, readTodoFile } from "../data/todoWriter";

const PRIORITY_CYCLE: (Priority | null)[] = [null, "high", "medium", "low"];
const PRIORITY_LABEL: Record<Priority, string> = { highest: "🔺", high: "⏫", medium: "🔼", low: "🔽", lowest: "⏬" };
const GROUP_CLS: Record<string, string> = { overdue: "aos-text-rose", today: "aos-text-amber", upcoming: "", someday: "" };

/**
 * TO-DO — <vault>/TODO.md in Tasks-plugin syntax (spec 2026-09-22-todo-and-proposals-tabs D1–D4, §4.4):
 * quick-add, Overdue / Today / Upcoming / Someday by priority, a tag filter, tick / edit / priority / due /
 * delete per row, and the week's done items. Every change re-reads the file (todoWriter) because /todo
 * writes it too. Parsing and edits live in src/data/todos.ts.
 */
export class TodoTab {
  private host: HTMLElement | null = null;
  private text: string | null = null;
  private items: Todo[] = [];
  private tagFilter: string | null = null;
  private showDone = false;
  private draft = "";
  private draftPriority: Priority | null = null;
  private draftDue = "";
  private editing: string | null = null;     // raw line of the item being edited inline
  private editBox: { input: HTMLInputElement; raw: string } | null = null;   // its box, while it is in the tab
  /** The edit box on its way through a redraw: the element itself, moved into the new row (render, renderRow). */
  private editKept: { input: HTMLInputElement; raw: string; start: number | null; end: number | null; dir: "forward" | "backward" | "none" | null; focused: boolean } | null = null;
  private listenersRegistered = false;
  private refreshDebounce: number | null = null;
  private tick: number | null = null;
  private renderedDay = "";

  constructor(private plugin: AgenticOSPlugin, private view: WorkbenchView) {}

  mount(host: HTMLElement): void {
    this.host = host;
    if (!this.listenersRegistered) {
      this.listenersRegistered = true;
      const watch = (f: TAbstractFile, oldPath?: string) => { if (f.path === TODO_PATH || oldPath === TODO_PATH) this.schedule(); };
      const vault = this.plugin.app.vault;
      this.view.registerEvent(vault.on("modify", (f) => watch(f)));
      this.view.registerEvent(vault.on("create", (f) => watch(f)));
      this.view.registerEvent(vault.on("delete", (f) => watch(f)));
      this.view.registerEvent(vault.on("rename", (f, oldPath) => watch(f, oldPath)));
    }
    // Regroup when the local day rolls over (a Today item becomes Overdue at midnight).
    if (this.tick === null) this.tick = window.setInterval(() => { if (localDay(new Date()) !== this.renderedDay) this.render(); }, 60_000);
    void this.refresh();
  }

  unmount(): void {
    if (this.tick !== null) { window.clearInterval(this.tick); this.tick = null; }
    if (this.refreshDebounce !== null) { window.clearTimeout(this.refreshDebounce); this.refreshDebounce = null; }
  }

  private schedule(): void {
    if (this.refreshDebounce !== null) window.clearTimeout(this.refreshDebounce);
    this.refreshDebounce = window.setTimeout(() => void this.refresh(), 250);
  }

  async refresh(): Promise<void> {
    try { this.text = await readTodoFile(adapterOf(this.plugin.app)); } catch { this.text = null; }
    this.load(this.text);
  }

  private load(text: string | null): void {
    this.text = text;
    this.items = text ? parseTodos(text) : [];
    if (this.editing && !this.items.some((t) => t.raw === this.editing)) {
      // The line being edited changed or went in TODO.md meanwhile: the edit cannot land on it, and is said, not lost quietly.
      const typed = this.editBox && this.editBox.raw === this.editing ? this.editBox.input.value.trim() : "";
      this.editing = null;
      new Notice(`That todo changed in TODO.md while you were editing it, so your edit was not saved${typed ? `: "${typed}"` : ""}.`, 10_000);
    }
    this.view.setBadge("todo", todoBadgeCount(text, localDay(new Date())));
    this.render();
  }

  /** One edit: re-read, apply, write, re-render. A line changed elsewhere is reported, never guessed. */
  private async apply(edit: (text: string | null) => string): Promise<boolean> {
    try {
      this.load(await applyTodoEdit(adapterOf(this.plugin.app), edit));
      return true;
    } catch (e) {
      if (e instanceof StaleTodoError) { new Notice("TODO.md changed underneath — reloaded, try again"); await this.refresh(); }
      else new Notice(`To-Do: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  // ── render ──

  private render(): void {
    if (!this.view.isTabActive("todo")) return;
    const host = this.host;
    if (!host) return;
    const hadFocus = host.contains(document.activeElement) && (document.activeElement as HTMLElement).hasClass("aos-td-input");
    // A redraw during an edit (any TODO.md event: another writer, a hook, a late event for this tab's own write; the day
    // rolling over) goes on around the editor: its box is the same element, moved into the new row, so what was typed,
    // the selection, the focus and a keystroke on its way all stay. It is not the edit box while it moves, so the blur
    // its removal may fire never saves.
    const was = this.editBox;
    this.editBox = null;
    this.editKept = was && this.editing === was.raw
      ? { input: was.input, raw: was.raw, start: was.input.selectionStart, end: was.input.selectionEnd, dir: was.input.selectionDirection, focused: document.activeElement === was.input }
      : null;
    host.empty();
    const today = localDay(new Date());
    this.renderedDay = today;
    const groups = groupTodos(this.items, today);
    const open = this.items.filter((t) => !t.done);

    const head = host.createDiv({ cls: "aos-rt-head" });
    head.createSpan({ cls: "aos-rt-title", text: "To-do" });
    head.createSpan({ cls: "aos-dim aos-rt-count", text: `${open.length} open · ${groups.overdue.length} overdue · ${groups.today.length} today` });
    const actions = head.createDiv({ cls: "aos-rt-actions" });
    const openFile = actions.createEl("button", { cls: "aos-ws-action", text: "open TODO.md", attr: { "data-tour": "todo-open-file" } });
    openFile.addEventListener("click", () => void this.openFile());

    this.renderQuickAdd(host, hadFocus);

    const tags = openTags(this.items);
    if (this.tagFilter && !tags.includes(this.tagFilter)) this.tagFilter = null;
    if (tags.length) {
      const bar = host.createDiv({ cls: "aos-td-tags" });
      for (const t of [null, ...tags]) {
        const chip = bar.createSpan({ cls: `aos-pill ${this.tagFilter === t ? "aos-pill-cyan" : "aos-pill-dim"} aos-td-tagchip`, text: t === null ? "all" : `#${t}` });
        chip.addEventListener("click", () => { this.tagFilter = t; this.render(); });
      }
    }

    const keep = (t: Todo) => !this.tagFilter || t.tags.includes(this.tagFilter);
    let shown = 0;
    for (const g of GROUPS) {
      const rows = groups[g.id].filter(keep);
      if (!rows.length) continue;
      shown += rows.length;
      const sub = host.createDiv({ cls: `aos-rt-subhead aos-dim ${GROUP_CLS[g.id]}` });
      sub.createSpan({ text: `${g.label} (${rows.length})` });
      const table = host.createDiv({ cls: "aos-inv-table aos-rt-table" });
      for (const t of rows) this.renderRow(table, t, today);
    }
    if (!shown) {
      host.createDiv({
        cls: "aos-inv-table aos-rt-table",
      }).createDiv({
        cls: "aos-inv-row aos-dim",
        text: this.tagFilter ? `Nothing open tagged #${this.tagFilter}.` : `Nothing open — add one above, or run ${invocationHint("todo", readAgenticosJson())} <text> in a session.`,
      });
    }

    const done = doneThisWeek(this.items, today).filter(keep);
    const sub = host.createDiv({ cls: "aos-rt-subhead aos-dim aos-pr-grouphead", attr: { "data-tour": "todo-done" } });
    sub.createSpan({ text: `${this.showDone ? "▾" : "▸"} DONE THIS WEEK (${done.length})` });
    sub.addEventListener("click", () => { this.showDone = !this.showDone; this.render(); });
    if (this.showDone && done.length) {
      const table = host.createDiv({ cls: "aos-inv-table aos-rt-table" });
      for (const t of done) this.renderRow(table, t, today);
    }
  }

  private renderQuickAdd(host: HTMLElement, refocus: boolean): void {
    const row = host.createDiv({ cls: "aos-td-add" });
    const input = row.createEl("input", {
      cls: "aos-rt-input aos-td-input",
      attr: { type: "text", placeholder: "Add a todo — #tags, ⏫ and 📅 2026-10-01 work inline", "aria-label": "New todo" },
    });
    input.value = this.draft;
    input.addEventListener("input", () => { this.draft = input.value; });
    const prio = row.createEl("select", { cls: "aos-rt-input aos-td-prio", attr: { "aria-label": "Priority" } });
    for (const p of PRIORITY_CYCLE) {
      const o = prio.createEl("option", { text: p ? `${PRIORITY_LABEL[p]} ${p}` : "no priority", attr: { value: p ?? "" } });
      if (p === this.draftPriority) o.selected = true;
    }
    prio.addEventListener("change", () => { this.draftPriority = (prio.value || null) as Priority | null; });
    const due = row.createEl("input", { cls: "aos-rt-input aos-td-date", attr: { type: "date", "aria-label": "Due date" } });
    due.value = this.draftDue;
    due.addEventListener("change", () => { this.draftDue = due.value; });
    const add = row.createEl("button", { cls: "aos-ws-action", text: "+ add" });
    const submit = async () => {
      let body = this.draft.trim();
      if (!body) return;
      if (this.draftPriority) body = withPriority(body, this.draftPriority);
      if (this.draftDue) body = withDue(body, this.draftDue);
      if (await this.apply((t) => addTodo(t, body))) {
        this.draft = ""; this.draftPriority = null; this.draftDue = "";
        this.render();
      }
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void submit(); } });
    add.addEventListener("click", () => void submit());
    if (refocus) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }

  private renderRow(table: HTMLElement, t: Todo, today: string): void {
    const row = table.createDiv({ cls: `aos-inv-row aos-td-row${t.done ? " is-done" : ""}` });
    const box = row.createEl("input", { cls: "aos-td-check", attr: { type: "checkbox", "aria-label": t.done ? "Mark open" : "Mark done" } });
    box.checked = t.done;
    box.addEventListener("change", () => void this.apply((x) => toggleTodo(x ?? "", t.raw, localDay(new Date()))));

    if (this.editing === t.raw) {
      const kept = this.editKept?.raw === t.raw ? this.editKept : null;
      this.editKept = null;
      if (kept) {
        row.appendChild(kept.input);
        this.editBox = { input: kept.input, raw: t.raw };
        if (kept.focused) kept.input.focus();
        const end = kept.input.value.length;
        kept.input.setSelectionRange(kept.start ?? end, kept.end ?? end, kept.dir ?? undefined);
        return;
      }
      const input = row.createEl("input", { cls: "aos-rt-input aos-td-edit", attr: { type: "text", "aria-label": "Edit todo" } });
      this.editBox = { input, raw: t.raw };
      input.value = t.body;
      const save = async () => {
        const body = input.value.trim();
        if (!body || body === t.body) { this.editing = null; this.render(); return; }
        this.editing = null;
        await this.apply((x) => editTodo(x ?? "", t.raw, body));
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); void save(); }
        else if (e.key === "Escape") { e.preventDefault(); this.editing = null; this.render(); }
      });
      // A blur saves, unless the box has the focus again by then (a redraw moved it and gave it back).
      input.addEventListener("blur", () => { if (this.editBox?.input === input && this.editing === t.raw && document.activeElement !== input) void save(); });
      // The row is already in the tab, so focus now: a deferred caret move can land between a select-all and the typing.
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      return;
    }

    const text = row.createSpan({ cls: "aos-td-text", text: t.text || t.body, attr: { title: "Double-click to edit" } });
    text.addEventListener("dblclick", () => { this.editing = t.raw; this.render(); });
    for (const tag of t.tags) {
      const chip = row.createSpan({ cls: "aos-pill aos-pill-dim aos-td-tag", text: `#${tag}` });
      chip.addEventListener("click", () => { this.tagFilter = tag; this.render(); });
    }

    if (t.done) {
      row.createSpan({ cls: "aos-dim aos-td-when", text: t.doneOn ? `✅ ${t.doneOn}` : "✅" });
      return;
    }
    const prio = row.createEl("button", {
      cls: "aos-td-prio-btn", text: t.priority ? PRIORITY_LABEL[t.priority] : "·",
      attr: { "aria-label": `Priority: ${t.priority ?? "none"} — click to change`, title: `priority: ${t.priority ?? "none"} (click to cycle)` },
    });
    prio.addEventListener("click", () => {
      const i = PRIORITY_CYCLE.indexOf(t.priority && PRIORITY_CYCLE.includes(t.priority) ? t.priority : null);
      const next = PRIORITY_CYCLE[(i + 1) % PRIORITY_CYCLE.length];
      void this.apply((x) => editTodo(x ?? "", t.raw, withPriority(t.body, next)));
    });
    if (t.due && t.due < today) {
      const late = Math.round((Date.parse(`${today}T00:00:00`) - Date.parse(`${t.due}T00:00:00`)) / 86_400_000);
      row.createSpan({ cls: "aos-text-rose aos-td-when", text: `${late}d late` });
    } else if (t.due === today) row.createSpan({ cls: "aos-text-amber aos-td-when", text: "today" });
    else if (t.due === addDays(today, 1)) row.createSpan({ cls: "aos-dim aos-td-when", text: "tomorrow" });
    const due = row.createEl("input", { cls: "aos-rt-input aos-td-date", attr: { type: "date", "aria-label": "Due date" } });
    due.value = t.due ?? "";
    due.addEventListener("change", () => void this.apply((x) => editTodo(x ?? "", t.raw, withDue(t.body, due.value || null))));
    const del = row.createEl("button", { cls: "aos-td-del", text: "✕", attr: { "aria-label": "Delete todo", title: "Delete (no undo — ticking keeps it in Done instead)" } });
    del.addEventListener("click", async () => {
      if (await ConfirmModal.ask(this.plugin.app, "Delete todo?", `"${t.text || t.body}" will be removed from TODO.md. Ticking it instead keeps it under Done.`, "Delete")) {
        await this.apply((x) => removeTodo(x ?? "", t.raw));
      }
    });
  }

  private async openFile(): Promise<void> {
    const vault = this.plugin.app.vault;
    try {
      const existing = vault.getAbstractFileByPath(TODO_PATH);
      const f = existing instanceof TFile ? existing : await vault.create(TODO_PATH, TODO_TEMPLATE);
      await this.plugin.app.workspace.getLeaf("tab").openFile(f);
    } catch (e) {
      new Notice(`Cannot open ${TODO_PATH}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
