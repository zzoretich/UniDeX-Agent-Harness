// The note pane's editor: CodeMirror 6 over one Markdown file. This is the app's own writer, not the HUD's: every save
// asks the write policy's editor check (canSave: the Notes surface), never the HUD's surfaces.
//
// Saving follows Obsidian: a second after typing stops, on ⌘S, and when the editor closes or the window unloads. Each
// save is a compare-and-set against the text this editor last read or wrote, because Obsidian (or anything else) may
// have the same file open: when the disk no longer holds that text, nothing is written and the pane shows a conflict
// until the user picks Reload (theirs) or Keep mine. A change on disk while there are no unsaved edits is simply taken.

import { Annotation, EditorState, Transaction, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { tags } from "@lezer/highlight";
import { bridge, callError } from "./bridge";
import { canSave, refuse } from "./guard";

/**
 * saved: the disk holds the editor's text · unsaved: edits wait for the next save · saving: a write is under way ·
 * conflict: the disk changed under unsaved edits · deleted: the file is gone · refused: the write policy said no.
 */
export type SaveState = "saved" | "unsaved" | "saving" | "conflict" | "deleted" | "refused";

export interface NoteEditorOptions {
  /** The file, absolute (for the disk and the policy) and vault-relative (for messages). */
  abs: string;
  rel: string;
  /** Called whenever the save state changes. */
  onState: (state: SaveState) => void;
  /** How long typing must pause before an autosave. */
  delayMs?: number;
}

/** Marks a change that came from the disk: it is not an edit, so it neither autosaves nor joins the undo history. */
const fromDisk = Annotation.define<boolean>();

const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--compat-text)", backgroundColor: "transparent", fontSize: "13px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--compat-mono)", lineHeight: "1.6" },
  ".cm-content": { padding: "18px 28px 48px", maxWidth: "820px", caretColor: "var(--compat-accent)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--compat-accent)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--udx-info-bg)" },
  ".cm-activeLine": { backgroundColor: "var(--udx-surface)" },
  ".cm-selectionMatch": { backgroundColor: "var(--udx-raised-2)" },
  ".cm-panels": { backgroundColor: "var(--compat-panel)", color: "var(--compat-text)", borderColor: "var(--compat-border)" },
  ".cm-searchMatch": { backgroundColor: "var(--udx-warn-bg)" },
});

const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "700", color: "var(--udx-text)" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "var(--compat-accent)" },
  { tag: tags.monospace, color: "var(--udx-text-2)" },
  { tag: tags.quote, color: "var(--compat-dim)", fontStyle: "italic" },
  { tag: [tags.processingInstruction, tags.contentSeparator, tags.meta], color: "var(--compat-dim)" },
  { tag: tags.list, color: "var(--compat-text)" },
  // The frontmatter's YAML.
  { tag: [tags.propertyName, tags.definition(tags.propertyName)], color: "var(--udx-text-2)" },
  { tag: [tags.string, tags.content], color: "var(--compat-text)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--udx-warn)" },
  { tag: [tags.punctuation, tags.separator, tags.squareBracket, tags.brace], color: "var(--compat-dim)" },
]);

export class NoteEditor {
  readonly view: EditorView;
  state: SaveState = "saved";
  /** The text on disk as this editor last read or wrote it: what a save expects to find there. */
  private base: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> | null = null;
  private readonly delayMs: number;
  /** The last ⌘/Ctrl shortcut the editor left to the app, and the last click, for telling a user's move from a theft. */
  private lastShortcut = 0;
  private lastPointer: { target: Node | null; at: number } = { target: null, at: 0 };
  private hadFocus = false;
  private readonly cleanups: Array<() => void> = [];

  constructor(parent: HTMLElement, text: string, private readonly opts: NoteEditorOptions) {
    this.base = text;
    this.delayMs = opts.delayMs ?? 1000;
    const extensions: Extension[] = [
      history(),
      drawSelection(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      EditorView.lineWrapping,
      // Vault notes open with YAML frontmatter; plain Markdown would read its closing --- as a heading underline.
      yamlFrontmatter({ content: markdown() }),
      syntaxHighlighting(highlight),
      theme,
      keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { void this.save(); return true; } }, indentWithTab, ...searchKeymap, ...historyKeymap, ...defaultKeymap]),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged || u.transactions.every((t) => t.annotation(fromDisk))) return;
        if (this.state === "conflict" || this.state === "deleted") return; // paused until the user picks a side
        this.setState("unsaved");
        this.schedule();
      }),
    ];
    this.view = new EditorView({ state: EditorState.create({ doc: text, extensions }), parent });
    this.guardFocus();
  }

  /** The note as it is on disk now, or null when it is gone (or unreadable). */
  private readDisk(): string | null {
    const r = bridge().fs.readText(this.opts.abs);
    return r.ok ? r.data : null;
  }

  /** Saves `text` as the note editor (main allows it only where the Notes surface does). */
  private writeDisk(text: string): void {
    const r = bridge().fs.writeText(this.opts.abs, text, "editor");
    if (!r.ok) throw r.code === "EROFS" ? refuse("write", `save ${this.opts.rel}`) : callError(r, `save ${this.opts.rel}`);
  }

  get text(): string { return this.view.state.doc.toString(); }
  get dirty(): boolean { return this.text !== this.base; }

  focus(): void { this.view.focus(); }

  /** Saves now if there is anything to save and nothing stands in the way. Resolves when the disk is settled. */
  async save(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    while (this.saving) await this.saving;
    this.saving = this.saveOnce().finally(() => { this.saving = null; });
    await this.saving;
  }

  private async saveOnce(): Promise<void> {
    if (this.state === "conflict" || this.state === "deleted") return;
    if (!this.dirty) { this.setState("saved"); return; }
    if (!canSave(this.opts.abs)) {
      refuse("write", `save ${this.opts.rel}`);
      this.setState("refused");
      return;
    }
    const disk = this.readDisk();
    if (disk === null) { this.setState("deleted"); return; }
    if (disk !== this.base) { this.setState("conflict"); return; }
    const text = this.text;
    this.setState("saving");
    try {
      this.writeDisk(text);
    } catch (err) {
      console.error(`[compat] saving ${this.opts.rel} failed`, err);
      this.setState("unsaved");
      return;
    }
    this.base = text;
    // Typing that landed while the write was under way waits for the next save.
    if (this.dirty) { this.setState("unsaved"); this.schedule(); } else this.setState("saved");
  }

  /** The same save for a window that is going away: synchronous, so it finishes before the page does. */
  saveSync(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.state === "conflict" || this.state === "deleted" || !this.dirty || !canSave(this.opts.abs)) return;
    try {
      if (this.readDisk() !== this.base) return;
      const text = this.text;
      this.writeDisk(text);
      this.base = text;
      this.setState("saved");
    } catch (err) { console.error(`[compat] saving ${this.opts.rel} on unload failed`, err); }
  }

  /** The file changed on disk (a vault event): take it when there is nothing unsaved, else hold a conflict. */
  async diskChanged(): Promise<void> {
    while (this.saving) await this.saving;
    const disk = this.readDisk();
    if (disk === null) { this.setState("deleted"); return; }
    if (disk === this.base) {
      if (this.state === "deleted") this.setState(this.dirty ? "unsaved" : "saved");
      return; // this editor's own write, or no change
    }
    if (!this.dirty && this.state !== "conflict") { this.replace(disk); this.setState("saved"); return; }
    if (disk === this.text) { this.base = disk; this.setState("saved"); return; } // the disk caught up with the edits
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.setState("conflict");
  }

  /** Conflict: take the disk's text and drop the unsaved edits. */
  async reloadFromDisk(): Promise<void> {
    const disk = this.readDisk();
    if (disk === null) { this.setState("deleted"); return; }
    this.replace(disk);
    this.setState("saved");
  }

  /** Conflict: keep the edits and write them over what is on disk now (or recreate a deleted file). */
  async keepMine(): Promise<void> {
    const disk = this.readDisk();
    if (disk === null) {
      if (!canSave(this.opts.abs)) { refuse("write", `save ${this.opts.rel}`); this.setState("refused"); return; }
      this.writeDisk(this.text);
      this.base = this.text;
      this.setState("saved");
      return;
    }
    this.base = disk;
    this.setState("unsaved");
    await this.save();
  }

  destroy(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    for (const c of this.cleanups.splice(0)) c();
    this.view.destroy();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.save(); }, this.delayMs);
  }

  private replace(text: string): void {
    this.base = text;
    const head = Math.min(this.view.state.selection.main.head, text.length);
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      selection: { anchor: head },
      annotations: [fromDisk.of(true), Transaction.addToHistory.of(false)],
    });
  }

  private setState(s: SaveState): void {
    if (this.state === s) return;
    this.state = s;
    this.opts.onState(s);
  }

  /**
   * The HUD's terminal focuses itself on every re-render (TerminalPanel). With a note
   * being edited beside a visible Term, that would send the keys meant for the note into a live shell. Focus that
   * moves from this editor into a terminal goes back to the editor, unless the user moved it: a click in that
   * terminal, or a ⌘/Ctrl shortcut the editor did not handle itself (⌘9 opening the Term tab, say) just before.
   */
  private guardFocus(): void {
    const onPointer = (e: PointerEvent): void => { this.lastPointer = { target: e.target instanceof Node ? e.target : null, at: performance.now() }; };
    // Bubble phase, so a key the editor handled (⌘Z, ⌘↓, ⌘S) arrives here already marked defaultPrevented. The
    // modifier's own keydown (⌘ pressed on its own) is not a shortcut.
    const MODIFIERS = new Set(["Meta", "Control", "Shift", "Alt"]);
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !MODIFIERS.has(e.key) && !e.defaultPrevented) this.lastShortcut = performance.now();
    };
    const onFocusIn = (e: FocusEvent): void => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t && this.view.dom.contains(t)) { this.hadFocus = true; return; }
      const term = t?.closest(".xterm");
      const now = performance.now();
      const clicked = !!term && !!this.lastPointer.target && term.contains(this.lastPointer.target) && now - this.lastPointer.at < 1000;
      const stolen = this.hadFocus && !!term && !clicked && now - this.lastShortcut > 500 && this.view.dom.isConnected && this.view.dom.offsetParent !== null;
      if (stolen) { this.view.focus(); return; }
      this.hadFocus = false;
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocusIn, true);
    this.cleanups.push(() => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocusIn, true);
    });
  }
}
