import { setIcon } from "obsidian";
import type { SessionHost } from "../data/aosConfig";
import { ACCESS_LEVELS, CODEX_ACCESS_NOTE, accessHostLine, accessLabel, type AccessLevel } from "../data/agentSessions";
import type { HostSessionAccess } from "../host";

/** Each level's icon, in the table form the compat scanner reads. */
const LEVEL_ICONS: { id: HostSessionAccess; icon: string }[] = [
  { id: "read", icon: "eye" },
  { id: "edit", icon: "pencil" },
  { id: "run", icon: "terminal" },
];

/** What Vault chat's fixed chip says on hover: a Vault question runs without tools (spec U9). */
export const VAULT_ACCESS_TITLE = "Vault questions never change files";

export interface AccessMenuOptions {
  /** The thread's or the draft's host: Codex adds the sandbox note under the levels. */
  host: SessionHost | null;
  value: HostSessionAccess;
  /** Vault chat: a chip that reads "Read only" with a lock, and no menu. */
  fixed?: boolean;
  disabled?: boolean;
  onChange?: (level: HostSessionAccess) => void;
}

/**
 * The composer's access chip (spec 2026-10-07-sessions-ux U7): `Edit files ▾` opens a menu above it with the three
 * levels, what each runs as on each host, and a check on the chosen one. The owner keeps the value; the menu only
 * reports a pick through onChange. Keys: ↑↓ move, Enter or Space picks, Escape closes; focus goes back to the chip.
 */
export class AccessMenu {
  readonly el: HTMLElement;
  private opts: AccessMenuOptions;
  private trigger: HTMLElement | null = null;
  private menu: HTMLElement | null = null;

  constructor(parent: HTMLElement, opts: AccessMenuOptions) {
    this.opts = { ...opts };
    this.el = parent.createDiv({ cls: "aos-am" });
    // Focus that leaves the chip and its menu (a click elsewhere, Tab) closes the menu without pulling focus back.
    this.el.addEventListener("focusout", (e) => {
      const next = e.relatedTarget as Node | null;
      if (this.menu && (!next || !this.el.contains(next))) this.close(false);
    });
    // Escape anywhere inside an open menu, the chip included (Shift+Tab from an item lands there), only closes it:
    // the tab's own Escape (stop a running turn) must not see that key.
    this.el.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !this.menu) return;
      e.preventDefault();
      e.stopPropagation();
      this.close();
    });
    this.render();
  }

  /** Takes a new host, value or mode; an open menu stays open and redraws. */
  update(opts: Partial<AccessMenuOptions>): void {
    this.opts = { ...this.opts, ...opts };
    const wasOpen = !!this.menu;
    const focused = this.menu ? this.items().indexOf(document.activeElement as HTMLElement) : -1;
    // The owner redraws the chip after a pick, while the old trigger has focus: the new one takes it.
    const onTrigger = !!this.trigger && document.activeElement === this.trigger;
    this.render();
    if (wasOpen && !this.opts.fixed && !this.opts.disabled) this.open(focused);
    else if (onTrigger && this.trigger instanceof HTMLButtonElement && !this.trigger.disabled) this.trigger.focus();
  }

  isOpen(): boolean {
    return !!this.menu;
  }

  /** Opens the menu with focus on the item at `index`, or on the chosen level. */
  open(index = -1): void {
    if (this.opts.fixed || this.opts.disabled || !this.trigger) return;
    this.close(false);
    const menu = this.el.createDiv({ cls: "aos-am-menu", attr: { role: "menu", "aria-label": "Access" } });
    this.menu = menu;
    menu.createDiv({ cls: "aos-am-head", text: "What the agent may do", attr: { "aria-hidden": "true" } });
    for (const level of ACCESS_LEVELS) this.renderItem(menu, level);
    if (this.opts.host === "codex") menu.createDiv({ cls: "aos-am-note", text: CODEX_ACCESS_NOTE });
    menu.addEventListener("keydown", (e) => this.onMenuKey(e));
    this.trigger.setAttr("aria-expanded", "true");
    this.el.addClass("is-open");
    const items = this.items();
    const chosen = ACCESS_LEVELS.findIndex((l) => l.id === this.opts.value);
    items[index >= 0 && index < items.length ? index : Math.max(0, chosen)]?.focus();
  }

  /** Closes the menu; focus goes back to the chip unless it already left for somewhere else. */
  close(focusTrigger = true): void {
    const menu = this.menu;
    if (!menu) return;
    this.menu = null;
    menu.detach();
    this.el.removeClass("is-open");
    this.trigger?.setAttr("aria-expanded", "false");
    if (focusTrigger) this.trigger?.focus();
  }

  destroy(): void {
    this.menu = null;
    this.trigger = null;
    this.el.detach();
  }

  private render(): void {
    this.menu = null;
    this.el.empty();
    this.el.removeClass("is-open");
    const { fixed, value } = this.opts;
    const access: HostSessionAccess = fixed ? "read" : value;
    this.el.setAttr("data-access", access);
    if (fixed) {
      const chip = this.el.createSpan({ cls: "aos-am-trigger is-fixed", attr: { title: VAULT_ACCESS_TITLE } });
      const lock = chip.createSpan({ cls: "aos-am-icon" });
      setIcon(lock, "lock");
      chip.createSpan({ cls: "aos-am-label", text: accessLabel("read") });
      this.trigger = null;
      return;
    }
    const b = this.el.createEl("button", {
      cls: "aos-am-trigger",
      attr: { type: "button", "aria-haspopup": "menu", "aria-expanded": "false", title: "What the agent may do" },
    });
    b.disabled = !!this.opts.disabled;
    const shield = b.createSpan({ cls: "aos-am-icon" });
    setIcon(shield, "shield");
    b.createSpan({ cls: "aos-am-label", text: accessLabel(access) });
    const caret = b.createSpan({ cls: "aos-am-caret" });
    setIcon(caret, "chevron-down");
    b.addEventListener("click", () => (this.menu ? this.close() : this.open()));
    b.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      this.open(e.key === "ArrowUp" ? ACCESS_LEVELS.length - 1 : -1);
    });
    this.trigger = b;
  }

  private renderItem(menu: HTMLElement, level: AccessLevel): void {
    const on = level.id === this.opts.value;
    const item = menu.createEl("button", {
      cls: `aos-am-item${on ? " is-checked" : ""}`,
      attr: { type: "button", role: "menuitemradio", "aria-checked": String(on), tabindex: "-1", "data-level": level.id },
    });
    const icon = LEVEL_ICONS.find((l) => l.id === level.id)?.icon;
    const iconEl = item.createSpan({ cls: "aos-am-itemicon" });
    if (icon) setIcon(iconEl, icon);
    const text = item.createSpan({ cls: "aos-am-text" });
    text.createSpan({ cls: "aos-am-name", text: level.label });
    text.createSpan({ cls: "aos-am-desc", text: level.description });
    text.createSpan({ cls: "aos-am-map", text: accessHostLine(level) });
    const check = item.createSpan({ cls: "aos-am-check" });
    if (on) setIcon(check, "check");
    item.addEventListener("click", () => this.pick(level.id));
  }

  private items(): HTMLElement[] {
    return this.menu ? Array.from(this.menu.querySelectorAll<HTMLElement>(".aos-am-item")) : [];
  }

  private onMenuKey(e: KeyboardEvent): void {
    const items = this.items();
    const i = items.indexOf(document.activeElement as HTMLElement);
    const n = items.length;
    // Escape bubbles to the container's listener, which closes the menu.
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (i >= 0) this.pick(ACCESS_LEVELS[i].id);
      return;
    }
    const j = { ArrowDown: (i + 1) % n, ArrowUp: (i - 1 + n) % n, Home: 0, End: n - 1 }[e.key];
    if (j === undefined || !n) return;
    e.preventDefault();
    items[j].focus();
  }

  private pick(level: HostSessionAccess): void {
    const changed = level !== this.opts.value;
    this.opts = { ...this.opts, value: level };
    this.close(false);
    this.render();
    this.trigger?.focus();
    if (changed) this.opts.onChange?.(level);
  }
}
