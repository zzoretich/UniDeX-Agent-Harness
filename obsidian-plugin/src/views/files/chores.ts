// The file chores (spec 2026-10-05-workbench-app phase 2, moved here by files-finder D13): a new note, rename, move
// and Trash, each in the drawer form with its live path check, now reached from the right-click menu and + New. The
// checks are vaultFiles' pure rules; the writes go through the vault API, which main checks against the Files surface.

import { Notice, TFile } from "obsidian";
import type AgenticOSPlugin from "../../../main";
import type { WorkbenchView } from "../WorkbenchView";
import { ConfirmModal } from "../../ui/ConfirmModal";
import { isProtected, movePath, newNotePath, quickOpenFiles, renamePath, type PathCheck } from "../../data/vaultFiles";

export interface ChoreHooks {
  /** A note was made, or a file moved or renamed to `path`: the tab shows its folder and selects it. */
  landed(path: string, from?: string): void;
}

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

  rename(path: string): void {
    const name = path.split("/").pop()!;
    this.form("Rename", [{ label: `rename ${name} to`, value: name }], "rename",
      ([n]) => renamePath(path, n, this.exists),
      async (to) => { await this.renameFile(path, to); this.hooks.landed(to, path); });
  }

  move(path: string): void {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    this.form("MOVE", [{ label: `move ${path.split("/").pop()} to folder`, value: dir, list: this.folders() }], "move",
      ([d]) => movePath(path, d, this.exists),
      async (to) => {
        const vault = this.plugin.app.vault;
        const target = to.includes("/") ? to.slice(0, to.lastIndexOf("/")) : "";
        if (target && !(await vault.adapter.exists(target))) await vault.createFolder(target);
        await this.renameFile(path, to);
        this.hooks.landed(to, path);
      });
  }

  private async renameFile(from: string, to: string): Promise<void> {
    const f = this.plugin.app.vault.getAbstractFileByPath(from);
    if (!f) throw new Error(`${from} is gone`);
    await this.plugin.app.vault.rename(f, to);
  }

  /** Moves `paths` to the macOS Trash after one confirm; the runtime's own files are left out (the menu offers none). */
  trash(paths: string[]): void {
    const list = paths.filter((p) => !isProtected(p));
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
        if (done.length) new Notice(done.length === 1 ? `${done[0]} moved to the Trash` : `${done.length} items moved to the Trash`);
      })();
    }).open();
  }

  /** Opens a text file in a note tab. */
  async openNote(path: string, newTab = true): Promise<void> {
    const f = this.plugin.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) await this.plugin.app.workspace.getLeaf(newTab ? "tab" : false).openFile(f);
    else new Notice(`${path} is gone`);
  }
}
