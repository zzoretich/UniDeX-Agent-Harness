// Notice (a toast) and setIcon (lucide, Obsidian's icon set).

import { createElement, icons, type IconNode } from "lucide";

let container: HTMLElement | null = null;

export class Notice {
  noticeEl: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(message: string | DocumentFragment, duration?: number) {
    // A live region, so a screen reader says each notice ("copied", "copy failed", why a Resume was refused) as it shows.
    container ??= document.body.createDiv({ cls: "notice-container", attr: { role: "status", "aria-live": "polite" } });
    this.noticeEl = container.createDiv({ cls: "notice" });
    // Read before setMessage: appending a fragment empties it.
    const text = typeof message === "string" ? message : message.textContent;
    this.setMessage(message);
    console.info("[notice]", text);
    this.noticeEl.addEventListener("click", () => this.hide());
    if (duration !== 0) this.timer = setTimeout(() => this.hide(), duration ?? 5000);
  }

  setMessage(message: string | DocumentFragment): this {
    this.noticeEl.empty();
    if (typeof message === "string") this.noticeEl.setText(message);
    else this.noticeEl.appendChild(message);
    return this;
  }

  hide(): void {
    if (this.timer) clearTimeout(this.timer);
    this.noticeEl.remove();
  }
}

/** "layout-dashboard" → "LayoutDashboard": Obsidian names lucide icons in kebab case, the lucide package in Pascal case. */
function lucideName(id: string): string {
  return id.split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
}

/** Obsidian's icon set is lucide; any lucide id the HUD names renders, and an unknown one shows a dot. */
export function setIcon(el: HTMLElement, iconId: string): void {
  el.empty();
  el.addClass("aos-compat-icon");
  el.setAttr("data-icon", iconId);
  const node = (icons as Record<string, IconNode | undefined>)[lucideName(ALIASES[iconId] ?? iconId)];
  if (!node) { el.setText("•"); return; }
  const svg = createElement(node, { width: "16", height: "16", "stroke-width": "2" });
  svg.classList.add("svg-icon", `lucide-${iconId}`);
  el.appendChild(svg);
}

/** Obsidian ids that are not lucide names. */
const ALIASES: Record<string, string> = { document: "file-text" };

export function getIconIds(): string[] {
  return Object.keys(icons).map((k) => k.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([A-Z])([A-Z][a-z])/g, "$1-$2").toLowerCase());
}
