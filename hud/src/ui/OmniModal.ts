import { App, FuzzySuggestModal, FuzzyMatch } from "obsidian";
import type { OmniItem } from "../data/omni";

// ⌘K omnisearch modal. Pure UI: getItems() returns the list `main.ts`'s
// openOmni() built BEFORE opening (it gathers every async source, calls
// buildOmniItems(), then constructs this) — no async work happens in here, so
// getItems() stays a synchronous FuzzySuggestModal override.
//
// onChooseItem dispatch: file/memory/skill are all vault-relative paths, so
// they resolve the same way with only `app` — handled directly. run/agent/
// action all need plugin-level state this modal has no handle on
// (openWorkbenchTab, RunsTab.showRun/showAgents, FixAction/deck execution), so
// those three are handed to `onAction`, the callback the caller supplied.
export class OmniModal extends FuzzySuggestModal<OmniItem> {
  constructor(
    app: App,
    private items: OmniItem[],
    private onAction: (item: OmniItem) => void,
  ) {
    super(app);
    this.setPlaceholder("Search files, memories, runs, agents, skills, actions…");
  }

  getItems(): OmniItem[] {
    return this.items;
  }

  getItemText(item: OmniItem): string {
    return `${item.label} ${item.hint}`;
  }

  renderSuggestion(match: FuzzyMatch<OmniItem>, el: HTMLElement): void {
    const item = match.item;
    el.addClass("aos-omni-suggestion");
    el.createSpan({ cls: "aos-omni-kind", text: item.kind });
    el.createSpan({ cls: "aos-omni-label", text: item.label });
    if (item.hint) el.createSpan({ cls: "aos-omni-hint aos-dim", text: item.hint });
  }

  onChooseItem(item: OmniItem): void {
    if (item.kind === "file" || item.kind === "memory" || item.kind === "skill") {
      void this.app.workspace.openLinkText(item.payload, "", true);
      return;
    }
    this.onAction(item);
  }
}
