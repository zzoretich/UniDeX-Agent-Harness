// CodePanes — the Code deck's panes behind the top bar's buttons (spec 2026-11-09-code-chat C8, §4), closed by default:
// Diff, the selected terminal's read-only git status and one file's diff through code:git (main picks the folder from the
// terminal's own cwd: a vault workspace or a workspace's linked code folder, and refuses any other place); Files, the Files
// tab at the terminal's vault workspace (the Files view is a whole tab bound to the Workbench, so it opens there rather
// than in a pane); Computer, today's Computer pane, opened or collapsed. Where main finds no repository (the vault root,
// home, any other folder, a workspace that is not a repository of its own) the Diff button, the branch and `+n −n` are
// hidden; Files shows only for a vault workspace. The status is read when a terminal is selected, when its output has
// settled, and when the Diff pane opens or is refreshed: never on a draw, one read at a time, and never while another rail
// tab is in front (ruling R55). A terminal main refused (the vault root, home, another folder) is not read again on its
// output or a selection: the answer can't change while the same process runs in the same place. A status that changed
// redraws the file list keeping its scroll and focus, and the open diff only when its text changed.

import { setIcon } from "obsidian";
import { hudHost, type HostGitDiff, type HostGitStatus } from "../host";
import type { TerminalSession } from "../data/terminalSession";
import type { Place } from "../data/terminalLaunch";
import { countsText, diffTotals, fileStatusLabel } from "../data/agentSessions";
import { renderDiff } from "./ThreadView";
import type { ComputerPane } from "./ComputerPane";

/** Quiet output this long reads the status again; a terminal that keeps printing is read at most every MAX_WAIT_MS. */
const SETTLE_MS = 1500;
const MAX_WAIT_MS = 5000;
/** A terminal selected again within this long keeps the status it had. */
const FRESH_MS = 3000;

export interface CodePanesHost {
  activeSession(): TerminalSession | undefined;
  placeOf(s: TerminalSession): Place;
  computer(): ComputerPane | null;
  /** The Files tab at a vault folder (vault-relative); none outside the Workbench. */
  openFiles?: (folder: string) => void;
  /** The selected terminal's status changed what the top bar shows (its branch, its counts). */
  changed(): void;
}

/** A terminal's last status; `refused`: main refused it (EROFS), with the place it was refused in, else null. */
interface Read { key: string; st: HostGitStatus | null; at: number; refused: string | null }
type Shown = { file: string; state: "loading" } | { file: string; state: "ok"; diff: HostGitDiff } | { file: string; state: "error"; error: string };

/** A status's branch as the top bar writes it: `⎇ main`, `⎇ detached`; null when it is not a repository. */
export function branchText(st: HostGitStatus | null): string | null {
  if (!st?.repo) return null;
  return `⎇ ${st.detached ? "detached" : st.branch ?? "no branch"}`;
}

/** The top bar's `+n −n` across a status's files; "" for a clean tree or no repository. */
export function totalsText(st: HostGitStatus | null): string {
  const t = diffTotals(st);
  return t.files ? countsText({ added: t.added, removed: t.removed }) : "";
}

/** A vault workspace's folder as Files names it, or null for a place that is not one. */
export function filesFolder(place: Place | null): string | null {
  return place && (place.kind === "workspace" || place.kind === "scratch") && place.workspace ? `workspaces/${place.workspace}` : null;
}

export class CodePanes {
  private paneEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private diffEl: HTMLElement | null = null;
  private headEl: HTMLElement | null = null;
  /** The Diff pane is open (closed by default; not saved). */
  private diffOpen = false;
  /** Each terminal's last status, by terminal id; `key` is the pty it was read for. */
  private reads = new Map<string, Read>();
  /** The terminal the panes follow, its output listener and the pending read. */
  private followed: { id: string; key: string } | null = null;
  private offData: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirtySince: number | null = null;
  private seq = 0;
  /** A status read is running; `again`: one more was asked for meanwhile (at most one waits). */
  private reading = false;
  private again = false;
  /** Another rail tab is in front: nothing is followed or read until show(). */
  private hidden = false;
  private shown: Shown | null = null;
  /** The file the person opened in each terminal's Diff, by terminal id: selected again when they come back to it, while
   *  that file is still in its list. */
  private picked = new Map<string, string>();
  private diffSeq = 0;
  /** What the bar and the pane last drew, so a draw that changes nothing leaves them (and their focus) alone. */
  private barSig = "";
  private paneSig = "";
  /** What the diff area last drew: a status that changed leaves an unchanged diff (and its scroll) alone. */
  private diffDrawn: { file: string | null; state: string; text: string; truncated: boolean; files: boolean } | null = null;

  constructor(private host: CodePanesHost) {}

  /** The Diff pane's element, docked in the deck after the terminal and before the Computer pane. */
  mount(parent: HTMLElement): void {
    const pane = parent.createEl("aside", { cls: "aos-cdp is-hidden", attr: { "aria-label": "Diff" } });
    this.paneEl = pane;
    this.headEl = pane.createDiv({ cls: "aos-cdp-head" });
    const body = pane.createDiv({ cls: "aos-cdp-body" });
    this.listEl = body.createDiv({ cls: "aos-cdp-files", attr: { role: "list" } });
    this.diffEl = body.createDiv({ cls: "aos-cdp-diff" });
  }

  destroy(): void {
    this.unfollow();
    this.again = false;
    this.paneEl?.detach();
    this.paneEl = this.listEl = this.diffEl = this.headEl = null;
    this.diffOpen = false;
    this.shown = null;
    this.barSig = this.paneSig = "";
    this.diffDrawn = null;
    this.seq++;
    this.diffSeq++;
  }

  /** The selected terminal's status as last read, or null (never a call). */
  statusOf(s: TerminalSession | undefined): HostGitStatus | null {
    const r = s ? this.reads.get(s.id) : undefined;
    return r && r.key === this.keyOf(s!) ? r.st : null;
  }

  /** Called on each top-bar draw for the selected terminal: follows it (its output, a first read). Cheap when it is the
   *  terminal already followed; nothing while hidden. `force` reads it even when its last read is fresh. */
  follow(s: TerminalSession | undefined, force = false): void {
    if (this.hidden) return;
    const key = s ? this.keyOf(s) : "";
    if (s && this.followed?.id === s.id && this.followed.key === key) return;
    this.unfollow();
    if (!s) { this.drawPane(); return; }
    this.followed = { id: s.id, key };
    this.offData = s.onData(() => this.poke());
    const r = this.reads.get(s.id);
    const read = force || (!this.refused(s) && (!r || r.key !== key || Date.now() - r.at > FRESH_MS));
    if (read) void this.refresh();
    this.shown = null;
    // The file opened in this terminal before: now, from a fresh status; else once the read answers.
    if (!read) this.restorePick(s);
    this.drawPane();
  }

  /** Another rail tab is in front (TerminalPanel.leave): stop following the terminal's output and drop a read that waits. */
  hide(): void {
    if (this.hidden) return;
    this.hidden = true;
    this.unfollow();
    this.again = false;
  }

  /** The Code tab is in front again: follow the selected terminal with one read. */
  show(): void {
    if (!this.hidden) return;
    this.hidden = false;
    this.follow(this.host.activeSession(), true);
  }

  /** The top bar's right: `+n −n`, then the Diff, Files and Computer buttons; drawn again only when what it shows changed. */
  renderBar(el: HTMLElement | null, s: TerminalSession | undefined, place: Place | null): void {
    if (!el) return;
    const st = this.statusOf(s);
    const totals = totalsText(st);
    const folder = filesFolder(place);
    const computer = this.host.computer();
    const cpState = computer?.paneState() ?? null;
    const sig = `${s?.id ?? ""}|${st?.repo ? 1 : 0}|${totals}|${this.diffOpen ? 1 : 0}|${folder ?? ""}|${this.host.openFiles ? 1 : 0}|${cpState ?? ""}`;
    if (sig === this.barSig && el.childElementCount) return;
    this.barSig = sig;
    el.empty();
    if (!s) return;
    if (totals) el.createSpan({ cls: "aos-cdp-total", text: totals, attr: { title: "Lines added and removed against HEAD" } });
    const btn = (cls: string, icon: string, label: string, pressed: boolean | null, fn: () => void, disabled = false) => {
      const b = el.createEl("button", { cls: `aos-cdp-btn ${cls}`, attr: { type: "button", "aria-label": label, title: label } });
      if (pressed !== null) b.setAttr("aria-pressed", String(pressed));
      if (disabled) b.disabled = true;
      setIcon(b, icon);
      b.addEventListener("click", fn);
    };
    if (st?.repo) btn("is-diff", "git-compare", this.diffOpen ? "Close the Diff pane" : "Diff: what changed in this repository", this.diffOpen, () => this.toggleDiff());
    if (folder && this.host.openFiles) btn("is-files", "folder-open", `Files: ${folder}`, null, () => this.host.openFiles?.(folder));
    if (computer && cpState) {
      const label = cpState === "off" ? "The Computer pane is off" : cpState === "open" ? "Collapse the Computer pane" : "Open the Computer pane";
      btn("is-computer", "monitor", label, cpState === "open", () => computer.toggle(), cpState === "off");
    }
  }

  /** Opens or closes the Diff pane; opening reads the status again. Closing it forgets the file open in it. */
  toggleDiff(): void {
    this.diffOpen = !this.diffOpen;
    const s = this.host.activeSession();
    if (!this.diffOpen && s) this.picked.delete(s.id);
    this.shown = null;
    this.drawPane();
    this.host.changed();
    if (this.diffOpen) void this.refresh();
  }

  /** The person opened `file` in the selected terminal's Diff (a row's click): shown, and remembered for that terminal,
   *  so switching to another terminal and back opens it again while it is still listed. */
  open(file: string): void {
    const s = this.host.activeSession();
    if (s) this.picked.set(s.id, file);
    void this.showFile(file);
  }

  /** Reads the followed terminal's status (code:git status) and draws what changed. One read at a time: asked for while
   *  one runs, it reads once after it, however often it was asked; nothing while hidden or unmounted. */
  async refresh(): Promise<void> {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.dirtySince = null;
    if (this.hidden || !this.paneEl) return;
    if (this.reading) { this.again = true; return; }
    this.reading = true;
    try { await this.read(); } finally { this.reading = false; }
    if (this.again) { this.again = false; void this.refresh(); }
  }

  // ── private ──

  private async read(): Promise<void> {
    const s = this.host.activeSession();
    const git = hudHost().code?.git;
    if (!s || !git) return;
    const key = this.keyOf(s);
    const pty = s.ptyId;
    const seq = ++this.seq;
    let st: HostGitStatus | null = null;
    let refused = false;
    if (pty) {
      try {
        const r = await git({ pty, op: "status" });
        st = r.ok && "files" in r.data ? r.data : null;
        refused = !r.ok && r.code === "EROFS";
      } catch { st = null; }
    }
    if (seq !== this.seq || !this.paneEl) return;
    const before = this.reads.get(s.id);
    this.reads.set(s.id, { key, st, at: Date.now(), refused: refused ? this.placeKey(s) : null });
    const sig = (x: HostGitStatus | null | undefined) => (x ? JSON.stringify(x) : "");
    // None shown yet (a terminal come back to, its status read again): the file opened there before, if still listed.
    if (before?.key === key && sig(before.st) === sig(st)) { this.restorePick(s); return; }
    // The file shown may have changed too: read it again.
    if (!this.hidden && this.shown && this.diffOpen) void this.showFile(this.shown.file);
    else this.restorePick(s);
    this.drawPane();
    this.host.changed();
  }

  /** Opens the file the person last opened in `s`'s Diff again, while the pane is open, nothing is shown yet and its
   *  status still lists that file; a file no longer listed is forgotten. */
  private restorePick(s: TerminalSession): void {
    const file = this.picked.get(s.id);
    if (file === undefined || this.shown || !this.diffOpen || this.hidden || this.host.activeSession()?.id !== s.id) return;
    const st = this.statusOf(s);
    if (!st) return;
    if (!st.files.some((f) => f.path === file)) { this.picked.delete(s.id); return; }
    void this.showFile(file);
  }

  /** A terminal and the process in it now: a read for the agent is not the login shell's after it. */
  private keyOf(s: TerminalSession): string { return `${s.id}:${s.ptyId ?? ""}`; }

  /** Where the terminal runs, as the page places it (a code folder linked since makes it a workspace's). */
  private placeKey(s: TerminalSession): string {
    const p = this.host.placeOf(s);
    return `${p.kind}|${p.dir}|${p.workspace ?? ""}|${p.linked ? 1 : 0}`;
  }

  /** Main refused this terminal's process in this place: its output and a selection read nothing more. */
  private refused(s: TerminalSession): boolean {
    const r = this.reads.get(s.id);
    return !!r && r.key === this.keyOf(s) && r.refused !== null && r.refused === this.placeKey(s);
  }

  private unfollow(): void {
    this.offData?.();
    this.offData = null;
    this.followed = null;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.dirtySince = null;
  }

  /** The followed terminal printed: read the status once its output settles, and at least every MAX_WAIT_MS meanwhile. */
  private poke(): void {
    const s = this.host.activeSession();
    if (s && this.followed?.id === s.id && this.refused(s)) return;
    const now = Date.now();
    this.dirtySince ??= now;
    if (this.timer !== null) clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(SETTLE_MS, this.dirtySince + MAX_WAIT_MS - now));
    this.timer = setTimeout(() => { this.timer = null; void this.refresh(); }, wait);
  }

  private async showFile(file: string): Promise<void> {
    if (this.hidden) return;
    const s = this.host.activeSession();
    const git = hudHost().code?.git;
    const pty = s?.ptyId;
    if (!s || !git || !pty) return;
    const seq = ++this.diffSeq;
    if (this.shown?.file !== file) { this.shown = { file, state: "loading" }; this.drawPane(); }
    let next: Shown;
    try {
      const r = await git({ pty, op: "diff", file });
      next = r.ok && "text" in r.data ? { file, state: "ok", diff: r.data } : { file, state: "error", error: r.ok ? "No diff" : r.error };
    } catch (e) { next = { file, state: "error", error: e instanceof Error ? e.message : String(e) }; }
    if (seq !== this.diffSeq || this.shown?.file !== file) return;
    this.shown = next;
    this.drawPane();
  }

  private drawPane(): void {
    const pane = this.paneEl;
    if (!pane || !this.headEl || !this.listEl || !this.diffEl) return;
    const s = this.host.activeSession();
    const st = this.statusOf(s);
    const open = this.diffOpen && !!st?.repo;
    pane.toggleClass("is-hidden", !open);
    if (!open || !st) {
      if (this.paneSig === "closed") return;
      this.paneSig = "closed";
      this.diffDrawn = null;
      this.headEl.empty();
      this.listEl.empty();
      this.diffEl.empty();
      return;
    }
    const shown = this.shown;
    // The head and the list: drawn again when the status or the open file changed, keeping the list's scroll and the focus.
    const sig = `${s?.id}|${JSON.stringify(st)}|${shown?.file ?? ""}`;
    if (sig !== this.paneSig) {
      this.paneSig = sig;
      const list = this.listEl;
      const top = list.scrollTop;
      const focus = focusedIn(pane);
      this.drawHead(this.headEl, st);
      list.empty();
      for (const f of st.files) {
        const item = list.createDiv({ cls: "aos-cdp-item", attr: { role: "listitem" } });
        const row = item.createEl("button", { cls: `aos-cdp-file${shown?.file === f.path ? " is-open" : ""}`, attr: { type: "button", "data-path": f.path, title: f.path } });
        row.createSpan({ cls: "aos-cdp-change", text: fileStatusLabel(f.status) });
        row.createSpan({ cls: "aos-cdp-path", text: f.path });
        const c = countsText(f);
        row.createSpan({ cls: `aos-cdp-counts${c ? "" : " is-binary"}`, text: c || "binary" });
        row.addEventListener("click", () => { this.open(f.path); });
      }
      list.scrollTop = top;
      if (focus) refocus(pane, focus);
    }
    this.drawDiff(this.diffEl, shown, st.files.length > 0);
  }

  private drawHead(head: HTMLElement, st: HostGitStatus): void {
    head.empty();
    head.createSpan({ cls: "aos-cdp-title", text: "Diff" });
    const branch = branchText(st);
    if (branch) head.createSpan({ cls: "aos-cdp-branch", text: branch });
    const totals = totalsText(st);
    head.createSpan({ cls: "aos-cdp-sum", text: st.files.length ? `${st.files.length} file${st.files.length === 1 ? "" : "s"}${totals ? ` · ${totals}` : ""}` : "No changes" });
    const icon = (cls: string, name: string, label: string, fn: () => void) => {
      const b = head.createEl("button", { cls: `aos-cdp-icon ${cls}`, attr: { type: "button", "aria-label": label, title: label } });
      setIcon(b, name);
      b.addEventListener("click", fn);
    };
    icon("is-refresh", "refresh-cw", "Read the status again", () => { void this.refresh(); });
    icon("is-close", "x", "Close the Diff pane", () => this.toggleDiff());
  }

  /** The open file's diff, drawn again only when what it shows changed; the same file keeps its scroll. */
  private drawDiff(el: HTMLElement, shown: Shown | null, files: boolean): void {
    const now = {
      file: shown?.file ?? null,
      state: shown ? (shown.state === "error" ? `error:${shown.error}` : shown.state) : "none",
      text: shown?.state === "ok" ? shown.diff.text : "",
      truncated: shown?.state === "ok" ? shown.diff.truncated : false,
      files,
    };
    const was = this.diffDrawn;
    if (was && was.file === now.file && was.state === now.state && was.text === now.text && was.truncated === now.truncated && was.files === now.files) return;
    // The same file drawn again (its text changed) keeps where it was scrolled: the area, and the diff's own box.
    const same = !!was && was.file === now.file;
    const box = el.querySelector<HTMLElement>(".aos-ss-diff");
    const keep = { top: el.scrollTop, boxTop: box?.scrollTop ?? 0, boxLeft: box?.scrollLeft ?? 0 };
    this.diffDrawn = now;
    el.empty();
    if (!shown) {
      if (files) el.createDiv({ cls: "aos-cdp-note", text: "Pick a file to see its diff." });
      return;
    }
    el.createDiv({ cls: "aos-cdp-diffpath", text: shown.file });
    if (shown.state === "loading") el.createDiv({ cls: "aos-cdp-note", text: "Reading the diff…" });
    else if (shown.state === "error") el.createDiv({ cls: "aos-cdp-note is-error", text: shown.error });
    else if (!shown.diff.text.trim()) el.createDiv({ cls: "aos-cdp-note", text: "No changes in this file against HEAD." });
    else renderDiff(el, shown.diff.text, shown.diff.truncated);
    if (!same) return;
    el.scrollTop = keep.top;
    const drawn = el.querySelector<HTMLElement>(".aos-ss-diff");
    if (drawn) { drawn.scrollTop = keep.boxTop; drawn.scrollLeft = keep.boxLeft; }
  }
}

/** What has the focus in the pane, as something a redraw can find again: a file row by its path, a head button by its
 *  class; null when the focus is elsewhere. */
function focusedIn(pane: HTMLElement): { path: string } | { cls: string } | null {
  const a = pane.ownerDocument?.activeElement;
  if (!(a instanceof HTMLElement) || !pane.contains(a)) return null;
  if (a.dataset.path !== undefined) return { path: a.dataset.path };
  for (const cls of ["is-refresh", "is-close"]) if (a.classList.contains(cls)) return { cls };
  return null;
}

function refocus(pane: HTMLElement, f: { path: string } | { cls: string }): void {
  for (const el of Array.from(pane.querySelectorAll<HTMLElement>("button"))) {
    if ("path" in f ? el.dataset.path === f.path : el.classList.contains(f.cls)) { el.focus({ preventScroll: true }); return; }
  }
}
