import { ItemView, WorkspaceLeaf, MarkdownRenderer, TFile, Notice, Component } from "obsidian";

export const VIEW_TYPE_MEMORY_INSPECTOR = "agentic-os-memory-inspector";

let pendingPath: string | null = null;
export function setPendingMemory(path: string): void { pendingPath = path; }
export function consumePendingMemory(): string | null {
  const p = pendingPath;
  pendingPath = null;
  return p;
}

export class MemoryInspectorView extends ItemView {
  private memoryPath: string | null = null;
  private renderHost: Component | null = null;

  constructor(leaf: WorkspaceLeaf) { super(leaf); }

  getViewType(): string { return VIEW_TYPE_MEMORY_INSPECTOR; }
  getDisplayText(): string { return this.memoryPath ? `Memory · ${pathBasename(this.memoryPath)}` : "Memory Inspector"; }
  getIcon(): string { return "book-open"; }

  async onOpen(): Promise<void> {
    const target = consumePendingMemory();
    if (target) this.memoryPath = target;
    await this.render();
  }

  async setMemoryPath(p: string): Promise<void> {
    this.memoryPath = p;
    await this.render();
  }

  async onClose(): Promise<void> {
    if (this.renderHost) {
      this.renderHost.unload();
      this.renderHost = null;
    }
  }

  private async render(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("aos-root", "aos-memscope");

    const header = root.createDiv({ cls: "aos-memscope-header" });
    header.createSpan({ cls: "aos-title", text: "Memory inspector" });

    if (!this.memoryPath) {
      root.createDiv({ cls: "aos-dim", text: "no memory selected" });
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(this.memoryPath);
    if (!(file instanceof TFile)) {
      root.createDiv({ cls: "aos-text-rose", text: `not found: ${this.memoryPath}` });
      return;
    }

    // path crumb
    const crumb = root.createDiv({ cls: "aos-memscope-crumb aos-dim" });
    crumb.textContent = this.memoryPath;
    const openLink = root.createEl("a", { cls: "aos-link", text: "▸ open in editor", href: "#" });
    openLink.addEventListener("click", async (e) => {
      e.preventDefault();
      await this.app.workspace.getLeaf("tab").openFile(file);
    });

    // rendered markdown
    const body = root.createDiv({ cls: "aos-memscope-body" });
    const raw = await this.app.vault.cachedRead(file);
    this.renderHost = new Component();
    this.renderHost.load();
    await MarkdownRenderer.renderMarkdown(raw, body, this.memoryPath, this.renderHost);

    // backlinks
    const backWrap = root.createDiv({ cls: "aos-memscope-backlinks" });
    backWrap.createDiv({ cls: "aos-panel-head" }).createSpan({ cls: "aos-panel-title", text: "BACKLINKS" });
    const backs = await this.findBacklinks(file);
    if (backs.length === 0) {
      backWrap.createDiv({ cls: "aos-dim", text: "none" });
    } else {
      const list = backWrap.createDiv({ cls: "aos-memscope-backlist" });
      for (const b of backs) {
        const row = list.createEl("a", { cls: "aos-memscope-backrow aos-link", href: "#" });
        row.textContent = b;
        row.addEventListener("click", async (e) => {
          e.preventDefault();
          const f = this.app.vault.getAbstractFileByPath(b);
          if (f instanceof TFile) await this.app.workspace.getLeaf("split", "vertical").openFile(f);
        });
      }
    }
  }

  private async findBacklinks(target: TFile): Promise<string[]> {
    const basename = target.basename.toLowerCase();
    const targetPath = target.path;
    const out: string[] = [];
    const all = this.app.vault.getMarkdownFiles();
    for (const f of all) {
      if (f.path === targetPath) continue;
      try {
        const body = await this.app.vault.cachedRead(f);
        const lower = body.toLowerCase();
        if (lower.includes(`[[${basename}]]`) ||
            lower.includes(`[[${basename}|`) ||
            lower.includes(`](${targetPath.toLowerCase()})`)) {
          out.push(f.path);
        }
      } catch { /* skip */ }
      if (out.length >= 100) break;
    }
    return out.sort();
  }
}

function pathBasename(p: string): string {
  return p.split("/").pop()?.replace(/\.md$/, "") || p;
}
