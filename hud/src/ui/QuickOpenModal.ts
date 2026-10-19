import { App, FuzzySuggestModal, FuzzyMatch, TFile } from "obsidian";
import { quickOpenFiles } from "../data/vaultFiles";

/**
 * Open file… (the Files tab's quick open): every file the vault indexes, matched fuzzily on its path, Markdown first.
 * Choosing one opens it in a tab, as a double-click in Files does, and tells `chosen` (Files' Recents, files-finder D20).
 */
export class QuickOpenModal extends FuzzySuggestModal<TFile> {
  private files: TFile[];

  constructor(app: App, private chosen?: (path: string) => void) {
    super(app);
    this.files = quickOpenFiles(app);
    this.setPlaceholder(`Open a file (${this.files.length} in the vault)…`);
  }

  getItems(): TFile[] {
    return this.files;
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  renderSuggestion(match: FuzzyMatch<TFile>, el: HTMLElement): void {
    const f = match.item;
    el.addClass("aos-omni-suggestion");
    el.createSpan({ cls: "aos-omni-label", text: f.name });
    const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
    if (dir) el.createSpan({ cls: "aos-omni-hint aos-dim", text: dir });
  }

  onChooseItem(file: TFile): void {
    this.chosen?.(file.path);
    void this.app.workspace.getLeaf("tab").openFile(file);
  }
}
