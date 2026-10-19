// The file chores (spec 2026-10-05-workbench-app phase 2, moved here by files-finder D13): the new-note and Move to…
// drawer forms with their live path checks, Trash after a confirm, and (files-finder D14–D17) the writes behind
// rename in place, New folder, Duplicate and drag to move: moves that take the links to them along, and their undo.
// The checks are vaultFiles' pure rules and the link plans vaultIndex's; the writes go through the vault API, which main
// checks against the Files surface.

import { Notice, TFile } from "obsidian";
import type AgenticOSPlugin from "../../../main";
import type { WorkbenchView } from "../WorkbenchView";
import { ConfirmModal } from "../../ui/ConfirmModal";
import { undoMoves, type UndoEntry } from "../../data/filesModel";
import { linkMove, movedPath, rewriteLinks, type RewritePlan } from "../../data/vaultIndex";
import { duplicatePath, holdsRuntime, isProtected, movePath, newFolderPath, newNotePath, quickOpenFiles, type Move, type PathCheck } from "../../data/vaultFiles";

export interface ChoreHooks {
  /** A note was made, or a file moved or renamed to `path`: the tab shows its folder and selects it. */
  landed(path: string, from?: string): void;
  /** Move to…'s move: the tab makes it as a drop would (its links, its undo), then follows it. */
  move(from: string, to: string): Promise<void>;
}

/** What a move did: the moves made (fewer than asked when one failed, and why), and the links it rewrote. */
export interface MoveResult {
  moved: Move[];
  failed: string | null;
  edits: UndoEntry["edits"];
  /** Links rewritten, and in how many notes. */
  links: number;
  notes: number;
  /** Notes that link to what moved but were left as they are: the runtime's (from the plan), and any that failed. */
  skipped: string[];
  unwritten: string[];
}

/** Names a folder copy never takes: the index skips them, and the write surfaces refuse them (compat ignore.ts). */
const NOT_COPIED = ["node_modules", "_worktrees"];
/** A folder with more than this in it is not duplicated from the tab. */
export const DUPLICATE_MAX = 2000;

export class FileChores {
  constructor(private plugin: AgenticOSPlugin, private view: WorkbenchView, private hooks: ChoreHooks) {}

  private exists = (p: string): boolean => this.plugin.app.vault.getAbstractFileByPath(p) !== null;

  /** Every folder that holds a listed file, for the folder pickers. */
  private folders(): string[] {
    const set = new Set<string>();
    for (const f of quickOpenFiles(this.plugin.app)) {
      const parts = f.path.split("/").slice(0, -1);
      for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join("/"));
    }
    return [...set].filter((d) => !isProtected(`${d}/`)).sort();
  }

  /**
   * A drawer with one or two text fields, a live check of what the action would do, and a button that runs it. `check`
   * turns the fields into a target path or a reason; `run` gets the path once the button is pressed.
   */
  private form(title: string, fields: { label: string; value: string; list?: string[] }[], verb: string, check: (values: string[]) => PathCheck, run: (path: string) => Promise<void>): void {
    this.view.openDrawer(title, (host) => {
      host.addClass("aos-fl-form");
      const inputs: HTMLInputElement[] = [];
      for (const [i, f] of fields.entries()) {
        const label = host.createEl("label", { cls: "aos-rt-field", text: f.label });
        const input = label.createEl("input", { cls: "aos-rt-input", attr: { type: "text", spellcheck: "false" } });
        input.value = f.value;
        if (f.list) {
          const id = `aos-fl-list-${i}`;
          const dl = label.createEl("datalist", { attr: { id } });
          for (const o of f.list) dl.createEl("option", { attr: { value: o } });
          input.setAttr("list", id);
        }
        inputs.push(input);
      }
      const note = host.createDiv({ cls: "aos-rt-errors" });
      const buttons = host.createDiv({ cls: "aos-capture-actions" });
      const go = buttons.createEl("button", { cls: "mod-cta", text: verb });
      const update = (): PathCheck => {
        const c = check(inputs.map((i) => i.value));
        note.setText(c.ok ? `→ ${c.path}` : c.error);
        note.toggleClass("is-ok", c.ok);
        go.disabled = !c.ok;
        return c;
      };
      for (const i of inputs) {
        i.addEventListener("input", update);
        i.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go.click(); } });
      }
      go.addEventListener("click", () => {
        const c = update();
        if (!c.ok) return;
        go.disabled = true;
        void run(c.path).then(() => this.view.closeDrawer(), (err: unknown) => {
          note.setText(`Not done: ${err instanceof Error ? err.message : String(err)}`);
          note.removeClass("is-ok");
          go.disabled = false;
        });
      });
      update();
      // At once, not on a timer: the drawer is already in the page, and a late timer would take the focus from a field
      // the user (or a test driver) has started typing in.
      const last = inputs[inputs.length - 1];
      last.focus();
      last.select();
    });
  }

  newNote(folder: string): void {
    this.form("New note", [{ label: "folder", value: folder, list: this.folders() }, { label: "name", value: "" }], "create",
      ([dir, name]) => newNotePath(dir, name, this.exists),
      async (path) => {
        const vault = this.plugin.app.vault;
        const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        if (dir && !(await vault.adapter.exists(dir))) await vault.createFolder(dir);
        const file = await vault.create(path, "");
        this.hooks.landed(path);
        await this.plugin.app.workspace.getLeaf("tab").openFile(file);
      });
  }

  /** Move to… (D14 keeps its folder picker): a folder that does not exist yet is made first. */
  move(path: string): void {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    this.form("MOVE", [{ label: `move ${path.split("/").pop()} to folder`, value: dir, list: this.folders() }], "move",
      ([d]) => movePath(path, d, this.exists),
      async (to) => {
        const vault = this.plugin.app.vault;
        const target = to.includes("/") ? to.slice(0, to.lastIndexOf("/")) : "";
        if (target && !(await vault.adapter.exists(target))) await vault.createFolder(target);
        await this.hooks.move(path, to);
      });
  }

  private async renameFile(from: string, to: string): Promise<void> {
    const f = this.plugin.app.vault.getAbstractFileByPath(from);
    if (!f) throw new Error(`${from} is gone`);
    await this.plugin.app.vault.rename(f, to);
  }

  /**
   * Makes `moves` one after another, stopping at the first that fails; then, when `plan` names notes, rewrites their
   * links to what actually moved (D17), each note read fresh and written only when its text changes. `paths` are the
   * vault's files before the moves, which the links resolve against.
   */
  async moveAll(moves: readonly Move[], plan: RewritePlan | null, paths: readonly string[]): Promise<MoveResult> {
    const r: MoveResult = { moved: [], failed: null, edits: [], links: 0, notes: 0, skipped: plan?.skipped.map((s) => s.path) ?? [], unwritten: [] };
    for (const m of moves) {
      try { await this.renameFile(m.from, m.to); r.moved.push(m); } catch (err) {
        r.failed = `${m.from.split("/").pop()}: ${err instanceof Error ? err.message : String(err)}`;
        break;
      }
    }
    if (!plan?.notes.length || !r.moved.length) return r;
    const vault = this.plugin.app.vault;
    const lm = linkMove(r.moved, paths);
    for (const n of plan.notes) {
      const home = n.path;
      const path = movedPath(home, r.moved);
      const f = vault.getFileByPath(path);
      if (!f) { r.unwritten.push(home); continue; }
      try {
        // Read first, so a note with nothing to change is not written at all; process then rewrites what it holds.
        if (!rewriteLinks(await vault.read(f), home, path, lm).count) continue;
        const edit = { before: "", after: "", count: 0 };
        await vault.process(f, (text) => {
          const out = rewriteLinks(text, home, path, lm);
          Object.assign(edit, { before: text, after: out.text, count: out.count });
          return out.text;
        });
        if (!edit.count) continue;
        r.edits.push({ home, path, before: edit.before, after: edit.after });
        r.links += edit.count;
        r.notes++;
      } catch {
        r.unwritten.push(home);
      }
    }
    return r;
  }

  /**
   * Undoes an entry (D16): each move back, the last first, then each rewritten note back to its text before, unless it
   * changed since (those are named, and left as they are). A move back that fails stops it and throws.
   */
  async undo(entry: UndoEntry): Promise<{ changed: string[] }> {
    for (const m of undoMoves(entry)) await this.renameFile(m.from, m.to);
    const vault = this.plugin.app.vault;
    const changed: string[] = [];
    for (const e of entry.edits) {
      const f = vault.getFileByPath(e.home);
      try {
        if (!f || (await vault.read(f)) !== e.after) { changed.push(e.home); continue; }
        await vault.process(f, (text) => (text === e.after ? e.before : text));
      } catch {
        changed.push(e.home);
      }
    }
    return { changed };
  }

  /** New folder (D14): `untitled folder` in `folder`, numbered when taken. Returns its path; throws why it cannot. */
  async newFolder(folder: string): Promise<string> {
    const c = newFolderPath(folder, this.exists);
    if (!c.ok) throw new Error(c.error);
    await this.plugin.app.vault.createFolder(c.path);
    return c.path;
  }

  /**
   * Duplicate (⌘D, D24): each path beside itself as `name copy`, a file with adapter.copy, a folder with everything in
   * it. Stops at the first that cannot be copied, keeping the ones made.
   */
  async duplicate(paths: readonly string[]): Promise<{ made: string[]; failed: string | null }> {
    const made: string[] = [];
    const exists = (p: string) => made.includes(p) || this.exists(p);
    for (const from of paths) {
      const node = this.plugin.app.vault.getAbstractFileByPath(from);
      if (!node) return { made, failed: `${from} is gone` };
      const folder = "children" in node;
      const c = duplicatePath(from, folder, exists);
      if (!c.ok) return { made, failed: c.error };
      try {
        if (folder) await this.copyFolder(from, c.path);
        else await this.plugin.app.vault.adapter.copy(from, c.path);
      } catch (err) {
        return { made, failed: err instanceof Error ? err.message : String(err) };
      }
      made.push(c.path);
    }
    return { made, failed: null };
  }

  /** A folder and everything in it, checked whole before the first copy: nothing hidden in it, at most DUPLICATE_MAX. */
  private async copyFolder(from: string, to: string): Promise<void> {
    const adapter = this.plugin.app.vault.adapter;
    const folders: string[] = [];
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      const l = await adapter.list(dir);
      for (const p of [...l.folders, ...l.files]) {
        const name = p.split("/").pop()!;
        if (name.startsWith(".") || NOT_COPIED.includes(name)) throw new Error(`${from} holds ${p.slice(from.length + 1)}, which Files does not copy`);
      }
      files.push(...l.files);
      if (folders.length + files.length > DUPLICATE_MAX) throw new Error(`${from} holds more than ${DUPLICATE_MAX.toLocaleString("en-US")} items; copy it in Finder`);
      for (const d of l.folders) { folders.push(d); await walk(d); }
    };
    await walk(from);
    const at = (p: string) => to + p.slice(from.length);
    await adapter.mkdir(to);
    for (const d of folders) await adapter.mkdir(at(d));
    for (const f of files) await adapter.copy(f, at(f));
  }

  /**
   * Moves `paths` to the macOS Trash after one confirm; the runtime's own files, and folders that hold them, are left
   * out (the menu offers none).
   * There is no undo (D16): Electron's trashItem cannot put a file back, so the toast says where to find it.
   */
  trash(paths: string[]): void {
    const list = paths.filter((p) => !isProtected(p) && !holdsRuntime(p));
    if (!list.length) return;
    const body = list.length === 1 ? `${list[0]} goes to the Trash. You can put it back from there.` : `${list.length} items go to the Trash: ${list.slice(0, 5).join(", ")}${list.length > 5 ? ", …" : ""}. You can put them back from there.`;
    new ConfirmModal(this.plugin.app, "Move to the Trash", body, "Move to Trash", (ok) => {
      if (!ok) return;
      void (async () => {
        const done: string[] = [];
        for (const p of list) {
          const f = this.plugin.app.vault.getAbstractFileByPath(p);
          if (!f) { new Notice(`${p} is gone`); continue; }
          try { await this.plugin.app.vault.trash(f, true); done.push(p); } catch (err) {
            new Notice(`Not moved to the Trash: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (done.length) {
          new Notice(done.length === 1
            ? `${done[0]} moved to the Trash. To put it back, open the Trash in Finder.`
            : `${done.length} items moved to the Trash. To put them back, open the Trash in Finder.`, 8000);
        }
      })();
    }).open();
  }

  /** Opens a text file in a note tab; at `line` (1-based, a search hit's, files-finder D22) when it is given. */
  async openNote(path: string, newTab = true, line?: number): Promise<void> {
    const f = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) { new Notice(`${path} is gone`); return; }
    // Obsidian's ephemeral state counts lines from 0.
    await this.plugin.app.workspace.getLeaf(newTab ? "tab" : false).openFile(f, line ? { eState: { line: line - 1 } } : undefined);
  }
}
