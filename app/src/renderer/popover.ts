// The tray popover: the SidebarHUD, in a small window main shows under the menubar icon. It is not a
// second HUD. This renderer opens the window (window.open, same origin, the one main allows) and mounts the plugin's
// own SidebarHUD view in it, so the view runs on the one plugin instance, as Obsidian's pop-out windows do. Elements
// are created by this document and adopted into the popover's, so they keep the Obsidian DOM helpers the HUD uses.

import { WorkspaceLeaf, type App } from "obsidian";
import { POPOVER } from "../shared/ipc";
import { BRAND } from "../shared/brand";

/** ../hud/src/views/SidebarHUD.ts VIEW_TYPE_SIDEBAR_HUD. */
const SIDEBAR_HUD = "agentic-os-sidebar-hud";

export async function openPopover(app: App): Promise<Window | null> {
  const child = window.open("about:blank", POPOVER);
  if (!child) return null;
  const doc = child.document;
  doc.title = BRAND.name;
  for (const link of Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))) {
    const l = doc.createElement("link");
    l.rel = "stylesheet";
    l.href = link.href;
    doc.head.appendChild(l);
  }
  doc.body.className = `${document.body.className} aos-popover`;
  // A leaf of its own, outside the workspace's panes and tab bars.
  const leaf = new WorkspaceLeaf(app.workspace, "right");
  leaf.containerEl.addClass("is-active", "aos-popover-leaf");
  doc.body.appendChild(leaf.containerEl);
  // The SidebarHUD only shows; the tray's menu (a right-click) opens the Workbench.
  await leaf.setViewState({ type: SIDEBAR_HUD });
  return child;
}
