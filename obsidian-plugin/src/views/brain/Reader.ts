// Library's reader, the middle pane (spec 2026-10-11-brain-hub D1, D2, D4–D7, D23; canvas Library.dc.html): the open
// memory's title, a mono meta line, its actions and its body rendered as markdown, with where BRAIN.md carries it.
// Every action is an `aos memory` verb through ctx.run (D13): Pin and Status through `set --expect <hash>`, so a file
// changed since it was read is refused, Keep, Archive and Restore (no memory is deleted, D6). Edit opens the file and
// changes nothing by itself (D4); ⧉ pops it out into the Memory inspector, kept from the Memory tab (D23). A draft
// offers Approve and Reject… (D6: a rejected draft is never drafted again); a pattern or a reflection, Edit and ⧉.
import { Component, MarkdownRenderer, Notice, setIcon } from "obsidian";
import {
  SET_STATUSES, bodyWithoutTitle, brainMdLine, brainMdSection, shortDay, type BrainDraft, type BrainMemory, type BrainNote,
  type SetResult, type SetStatus,
} from "../../data/brainModel";
import type { BrainCtx } from "./types";

export type ReaderItem =
  | { kind: "memories"; m: BrainMemory }
  | { kind: "drafts"; d: BrainDraft }
  | { kind: "patterns" | "reflections"; n: BrainNote };

export const readerPath = (it: ReaderItem): string => (it.kind === "memories" ? it.m.path : it.kind === "drafts" ? it.d.path : it.n.path);

export interface ReaderHandlers {
  /** Go to another file the reader names (Superseded by …). */
  open(path: string): void;
}

/** The element a redraw puts the focus back on, by its data-lib-key. */
export function focusedKey(scope: HTMLElement): string | null {
  const a = scope.ownerDocument.activeElement as HTMLElement | null;
  return a && scope.contains(a) ? a.getAttribute("data-lib-key") : null;
}

export function refocus(scope: HTMLElement, key: string | null): void {
  if (!key) return;
  for (const el of Array.from(scope.querySelectorAll<HTMLElement>("[data-lib-key]"))) {
    if (el.getAttribute("data-lib-key") === key) { el.focus({ preventScroll: true }); return; }
  }
}

export class LibraryReader {
  readonly el: HTMLElement;
  private md: Component | null = null;
  private sig = "";
  private path: string | null = null;
  private busy = false;
  /**
   * What `set` answered while the load still holds the file before it (D17): the next Pin or Status sends the new hash,
   * and Pin toggles from the new state, so a second press before the reload is not refused as changed (as Review does).
   */
  private sets = new Map<string, { was: string; now: string; pin: boolean }>();

  constructor(parent: HTMLElement, private ctx: BrainCtx, private on: ReaderHandlers) {
    this.el = parent.createEl("section", { cls: "aos-brain-main aos-lib-reader", attr: { "aria-label": "Reader" } });
  }

  /** Show `item`, or `empty` when there is none. Redraws only when what it shows changed, keeping the scroll and focus. */
  show(item: ReaderItem | null, empty: string): void {
    const d = this.ctx.data();
    for (const [p, x] of this.sets) if (d.byPath.get(p)?.hash !== x.was) this.sets.delete(p);
    const sig = item ? JSON.stringify(this.signature(item)) : `empty\n${empty}`;
    if (sig === this.sig) return;
    this.sig = sig;
    const path = item ? readerPath(item) : null;
    const top = path && path === this.path ? this.el.scrollTop : 0;
    const key = path && path === this.path ? focusedKey(this.el) : null;
    this.path = path;
    this.clear();
    if (!item) {
      this.el.setAttr("aria-label", "Reader");
      this.el.removeAttribute("data-path");
      this.el.removeAttribute("data-kind");
      this.el.createDiv({ cls: "aos-brain-empty aos-lib-rempty", text: empty });
      return;
    }
    this.el.setAttr("data-kind", item.kind);
    if (item.kind === "memories") this.memory(item.m, d.byPath);
    else if (item.kind === "drafts") this.draft(item.d);
    else this.note(item.kind, item.n);
    this.el.scrollTop = top;
    refocus(this.el, key);
  }

  /** Everything the pane draws from, so an unrelated reload leaves it alone. */
  private signature(it: ReaderItem): unknown[] {
    const d = this.ctx.data();
    if (it.kind === "memories") {
      const by = it.m.supersededBy ? d.byPath.get(it.m.supersededBy)?.title ?? null : null;
      return [it.kind, it.m.path, it.m.hash, brainMdSection(d.sources, it.m.path), !!d.sources?.omitted.includes(it.m.path), by];
    }
    if (it.kind === "drafts") return [it.kind, it.d.path, it.d.title, it.d.created, it.d.session, it.d.body];
    return [it.kind, it.n.path, it.n.title, it.n.created, it.n.updated, it.n.body];
  }

  private clear(): void {
    this.md?.unload();
    this.md = null;
    this.el.empty();
  }

  // ── a memory ──

  private memory(m: BrainMemory, byPath: ReadonlyMap<string, BrainMemory>): void {
    const now = this.ctx.data().now;
    this.el.setAttr("aria-label", m.title);
    this.el.setAttr("data-path", m.path);
    const head = this.el.createEl("header", { cls: "aos-lib-rhead" });
    const tr = head.createDiv({ cls: "aos-lib-rtitle" });
    tr.createEl("h2", { cls: "aos-lib-h2", text: m.title });
    if (m.pin) {
      // An archived or superseded memory keeps its pin (build-brain-md.js: a pin outlives an archive) but BRAIN.md leaves
      // it out until it is restored.
      const pill = tr.createSpan({ cls: "aos-lib-pinpill" });
      const ic = pill.createSpan({ cls: "aos-brain-ic", attr: { "aria-hidden": "true" } });
      setIcon(ic, "pin");
      pill.createSpan({ text: m.live ? "Pinned to BRAIN.md" : "Pinned: back in BRAIN.md once restored" });
    }
    if (m.status === "archived") tr.createSpan({ cls: "aos-brain-pill is-off", text: m.archived ? `Archived ${shortDay(m.archived, now) || m.archived}` : "Archived" });

    const meta = head.createDiv({ cls: "aos-lib-meta aos-brain-mono" });
    meta.createSpan({ cls: `aos-lib-metatype is-${m.type}`, text: m.type });
    meta.createSpan({ text: `status ${m.status ?? "active"}` });
    const upd = shortDay(m.updated ?? m.created, now);
    if (upd) meta.createSpan({ text: `updated ${upd}` });
    const from = [m.source, m.session ? `session ${m.session.slice(0, 8)}` : null].filter(Boolean).join(" · ");
    if (from) meta.createSpan({ text: from, attr: m.session ? { title: `session ${m.session}` } : {} });
    if (m.reviewed === true) meta.createSpan({ cls: "aos-lib-ok", text: "reviewed" });
    else if (m.reviewed === false) meta.createSpan({ cls: "aos-lib-warn", text: "to review" });

    if (m.status === "superseded") {
      const by = m.supersededBy ? byPath.get(m.supersededBy) : undefined;
      if (by) {
        const b = head.createEl("button", { cls: "aos-lib-superby", attr: { "data-action": "superseded", "data-path": by.path, "data-lib-key": "superseded" } });
        b.createSpan({ text: `Superseded by ${by.title} →` });
        b.addEventListener("click", () => this.on.open(by.path));
      } else {
        head.createDiv({ cls: "aos-lib-superby is-plain", text: m.supersededBy ? `Superseded by ${m.supersededBy}` : "Superseded" });
      }
    }

    const acts = this.actions(head);
    this.btn(acts, "edit", "Edit", () => this.ctx.edit(m.path));
    // Pin and Status only on a live memory: `set` refuses an archived or superseded one until it is restored (memory-ops).
    if (m.live) {
      const pinned = this.fresh(m)?.pin ?? m.pin;
      const b = this.btn(acts, pinned ? "unpin" : "pin", pinned ? "Unpin" : "Pin", async () => {
        const on = !(this.fresh(m)?.pin ?? m.pin);
        const r = await this.set(m, { pin: on }, on ? "Pin" : "Unpin");
        if (!r) return;
        // Shown at once; the reload after the verb redraws the pane from the file.
        b.setText(on ? "Unpin" : "Pin");
        b.setAttr("data-action", on ? "unpin" : "pin");
      }, "pin");
    }
    if (m.live) this.status(acts, m);
    if (m.reviewed === false) this.btn(acts, "keep", "Keep", () => this.ctx.run({ verb: "keep", paths: [m.path] }, "Keep"));
    if (m.live) this.btn(acts, "archive", "Archive", () => this.ctx.run({ verb: "archive", paths: [m.path] }, "Archive"), "archive");
    else this.btn(acts, "restore", "Restore", () => this.ctx.run({ verb: "restore", paths: [m.path] }, "Restore"), "archive");
    this.popOut(acts, m.path);

    const art = this.body(m.body, m.title, m.path);
    const sec = brainMdSection(this.ctx.data().sources, m.path);
    if (sec) {
      // brain-sources.json counts tokens per section (D10): the line says so when other memories share it, so the
      // section's total never reads as this memory's own cost.
      const box = art.createDiv({ cls: "aos-lib-inbrain", attr: { "data-section": sec.section } });
      box.createSpan({ cls: "aos-brain-label", text: "IN BRAIN.MD AS" });
      const line = box.createSpan({ cls: "aos-lib-inbrainline" });
      line.createSpan({ cls: "aos-lib-inbrainsec", text: sec.label });
      line.createSpan({ cls: "aos-brain-dim", text: ` · ${brainMdLine(sec)}`, attr: { title: "BRAIN.md counts tokens per section, not per memory" } });
    } else if (this.ctx.data().sources?.omitted.includes(m.path)) {
      const box = art.createDiv({ cls: "aos-lib-inbrain is-out" });
      box.createSpan({ cls: "aos-brain-label", text: "LEFT OUT OF BRAIN.MD" });
      box.createSpan({ cls: "aos-brain-dim", text: "Active context was full when BRAIN.md was last built, so this one did not fit." });
    }
  }

  /** "Status: active" over a native select (active · complete · paused), through `set --expect` (D17). */
  private status(acts: HTMLElement, m: BrainMemory): void {
    const cur = m.status ?? "active";
    const wrap = acts.createEl("label", { cls: "aos-lib-statusbtn", attr: { "data-action": "status" } });
    wrap.createSpan({ text: `Status: ${cur}` });
    const chev = wrap.createSpan({ cls: "aos-lib-chev", attr: { "aria-hidden": "true" } });
    setIcon(chev, "chevron-down");
    const sel = wrap.createEl("select", { cls: "aos-lib-oversel", attr: { "aria-label": "Set status", "data-lib-key": "act:status" } });
    if (!(SET_STATUSES as readonly string[]).includes(cur)) sel.createEl("option", { text: cur, value: cur, attr: { disabled: true } });
    for (const s of SET_STATUSES) sel.createEl("option", { text: s, value: s });
    sel.value = cur;
    sel.setAttr("aria-disabled", String(this.busy));
    sel.addEventListener("change", () => {
      const status = sel.value as SetStatus;
      if (this.busy) { sel.value = cur; return; }
      if (status === cur) return;
      // Refused without a change on disk (surface off, a timeout), the reload redraws nothing: the select goes back to
      // what the label says, so picking the same status again is a change again.
      void this.act(async () => { if (!(await this.set(m, { status }, "Status"))) sel.value = cur; });
    });
  }

  /** The answer `set` gave for `m` while the load still holds the text it was read from, else null. */
  private fresh(m: BrainMemory): { now: string; pin: boolean } | null {
    const x = this.sets.get(m.path);
    return x && x.was === m.hash ? x : null;
  }

  /** `aos memory set` with the newest hash this page knows (D17); true when it went through. */
  private async set(m: BrainMemory, fields: { pin?: boolean; status?: SetStatus }, label: string): Promise<boolean> {
    const f = this.fresh(m);
    const r = await this.ctx.run<SetResult>({ verb: "set", path: m.path, fields, expect: f?.now ?? m.hash }, label);
    if (!r.ok) return false;
    if (typeof r.json.hash === "string") this.sets.set(m.path, { was: m.hash, now: r.json.hash, pin: fields.pin ?? f?.pin ?? m.pin });
    return true;
  }

  // ── a draft ──

  private draft(d: BrainDraft): void {
    const now = this.ctx.data().now;
    this.el.setAttr("aria-label", d.title);
    this.el.setAttr("data-path", d.path);
    const head = this.el.createEl("header", { cls: "aos-lib-rhead" });
    head.createDiv({ cls: "aos-lib-rtitle" }).createEl("h2", { cls: "aos-lib-h2", text: d.title });
    const meta = head.createDiv({ cls: "aos-lib-meta aos-brain-mono" });
    meta.createSpan({ cls: "aos-lib-metatype is-feedback", text: "feedback draft" });
    const c = shortDay(d.created, now);
    if (c) meta.createSpan({ text: `created ${c}` });
    if (d.session) meta.createSpan({ text: `session ${d.session.slice(0, 8)}`, attr: { title: `session ${d.session}` } });
    const acts = this.actions(head);
    this.btn(acts, "approve", "Approve", async () => {
      const r = await this.ctx.run({ verb: "draft", action: "approve", slug: d.slug }, "Approve");
      if (r.ok) new Notice(`Approved: “${d.title}” is a feedback memory now.`);
    }, undefined, true);
    this.btn(acts, "reject", "Reject…", async () => {
      const yes = await this.ctx.confirm(`Reject “${d.title}”?`, "Removes this draft, and the rule is never drafted again. No memory changes.", "Reject");
      if (yes) await this.ctx.run({ verb: "draft", action: "reject", slug: d.slug }, "Reject");
    });
    this.btn(acts, "edit", "Edit", () => this.ctx.edit(d.path));
    this.body(d.body, d.title, d.path);
  }

  // ── a pattern or a reflection ──

  private note(kind: "patterns" | "reflections", n: BrainNote): void {
    const now = this.ctx.data().now;
    this.el.setAttr("aria-label", n.title);
    this.el.setAttr("data-path", n.path);
    const head = this.el.createEl("header", { cls: "aos-lib-rhead" });
    head.createDiv({ cls: "aos-lib-rtitle" }).createEl("h2", { cls: "aos-lib-h2", text: n.title });
    const meta = head.createDiv({ cls: "aos-lib-meta aos-brain-mono" });
    meta.createSpan({ cls: "aos-lib-metatype", text: kind === "patterns" ? "pattern" : "reflection" });
    const c = shortDay(n.created, now);
    const u = shortDay(n.updated, now);
    if (c) meta.createSpan({ text: `created ${c}` });
    if (u && u !== c) meta.createSpan({ text: `updated ${u}` });
    const acts = this.actions(head);
    this.btn(acts, "edit", "Edit", () => this.ctx.edit(n.path));
    this.popOut(acts, n.path);
    this.body(n.body, n.title, n.path);
  }

  // ── parts ──

  private actions(head: HTMLElement): HTMLElement {
    return head.createDiv({ cls: "aos-lib-actions", attr: { role: "toolbar", "aria-label": "Actions" } });
  }

  /** An action button; `key` keeps the focus across the redraw it causes (Pin → Unpin, Archive → Restore). */
  private btn(parent: HTMLElement, action: string, label: string, run: () => Promise<unknown> | void, key = action, primary = false): HTMLButtonElement {
    const b = parent.createEl("button", { cls: `aos-brain-btn is-small${primary ? " is-primary" : ""}`, text: label, attr: { "data-action": action, "data-lib-key": `act:${key}` } });
    b.setAttr("aria-disabled", String(this.busy));
    b.addEventListener("click", () => { void this.act(async () => { await run(); }); });
    return b;
  }

  private popOut(parent: HTMLElement, path: string): void {
    const b = parent.createEl("button", { cls: "aos-brain-iconbtn aos-lib-popout", attr: { "aria-label": "Open in split", title: "Open in split", "data-action": "popout", "data-lib-key": "act:popout" } });
    const ic = b.createSpan({ cls: "aos-brain-ic", attr: { "aria-hidden": "true" } });
    setIcon(ic, "copy");
    b.addEventListener("click", () => this.ctx.popOut(path));
  }

  /** One action at a time: the toolbar reads as off while a verb runs (aria-disabled, so the focus stays on the button
   *  that was pressed; the reload after it redraws the pane). */
  private async act(run: () => Promise<unknown>): Promise<void> {
    if (this.busy) return;
    this.setBusy(true);
    try { await run(); } finally { this.setBusy(false); }
  }

  private setBusy(on: boolean): void {
    this.busy = on;
    for (const x of Array.from(this.el.querySelectorAll<HTMLElement>(".aos-lib-actions button, .aos-lib-actions select"))) x.setAttribute("aria-disabled", String(on));
    this.el.querySelector(".aos-lib-actions")?.setAttribute("aria-busy", String(on));
  }

  /** The body as markdown (the title it repeats dropped), max 640 px; a Component per render, unloaded on the next. */
  private body(text: string, title: string, path: string): HTMLElement {
    const art = this.el.createEl("article", { cls: "aos-lib-article" });
    const md = bodyWithoutTitle(text, title);
    const host = art.createDiv({ cls: "aos-lib-md" });
    if (!md.trim()) { host.createDiv({ cls: "aos-brain-empty", text: "Nothing under the title yet." }); return art; }
    this.md = new Component();
    this.md.load();
    void MarkdownRenderer.renderMarkdown(md, host, path, this.md);
    return art;
  }

  destroy(): void {
    this.clear();
    this.sig = "";
    this.path = null;
  }
}
