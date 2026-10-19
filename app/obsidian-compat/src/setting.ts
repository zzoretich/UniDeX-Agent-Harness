// Setting and its components, emitting Obsidian's .setting-item DOM so the HUD's Settings tab and plugin rows keep
// their styles. Only the controls the HUD uses are built: toggle, dropdown, button, extra button and text.

import { setIcon } from "./notice";

abstract class BaseComponent {
  disabled = false;
  setDisabled(disabled: boolean): this { this.disabled = disabled; this.applyDisabled(); return this; }
  protected abstract applyDisabled(): void;
  then(cb: (c: this) => unknown): this { cb(this); return this; }
}

export class ButtonComponent extends BaseComponent {
  buttonEl: HTMLButtonElement;
  constructor(containerEl: HTMLElement) { super(); this.buttonEl = containerEl.createEl("button"); }
  protected applyDisabled(): void { this.buttonEl.disabled = this.disabled; this.buttonEl.toggleClass("is-disabled", this.disabled); }
  setButtonText(name: string): this { this.buttonEl.setText(name); return this; }
  setCta(): this { this.buttonEl.addClass("mod-cta"); return this; }
  removeCta(): this { this.buttonEl.removeClass("mod-cta"); return this; }
  setWarning(): this { this.buttonEl.addClass("mod-warning"); return this; }
  setIcon(icon: string): this { setIcon(this.buttonEl, icon); return this; }
  setTooltip(tip: string): this { this.buttonEl.setAttr("aria-label", tip); this.buttonEl.setAttr("title", tip); return this; }
  setClass(cls: string): this { this.buttonEl.addClass(cls); return this; }
  onClick(cb: (evt: MouseEvent) => unknown): this {
    this.buttonEl.addEventListener("click", (e) => { if (!this.disabled) void cb(e); });
    return this;
  }
}

export class ExtraButtonComponent extends BaseComponent {
  extraSettingsEl: HTMLElement;
  constructor(containerEl: HTMLElement) {
    super();
    this.extraSettingsEl = containerEl.createDiv({ cls: "clickable-icon extra-setting-button", attr: { role: "button", tabindex: "0" } });
  }
  protected applyDisabled(): void { this.extraSettingsEl.toggleClass("is-disabled", this.disabled); }
  setIcon(icon: string): this { setIcon(this.extraSettingsEl, icon); return this; }
  setTooltip(tip: string): this { this.extraSettingsEl.setAttr("aria-label", tip); this.extraSettingsEl.setAttr("title", tip); return this; }
  onClick(cb: () => unknown): this {
    const fire = (): void => { if (!this.disabled) void cb(); };
    this.extraSettingsEl.addEventListener("click", fire);
    this.extraSettingsEl.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fire(); } });
    return this;
  }
}

export class ToggleComponent extends BaseComponent {
  toggleEl: HTMLElement;
  private value = false;
  private changed: ((v: boolean) => unknown) | null = null;
  constructor(containerEl: HTMLElement) {
    super();
    this.toggleEl = containerEl.createDiv({ cls: "checkbox-container", attr: { role: "switch", tabindex: "0", "aria-checked": "false" } });
    this.toggleEl.createEl("input", { attr: { type: "checkbox", tabindex: "-1" } });
    const flip = (): void => { if (!this.disabled) { this.setValue(!this.value); void this.changed?.(this.value); } };
    this.toggleEl.addEventListener("click", flip);
    this.toggleEl.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); } });
  }
  protected applyDisabled(): void { this.toggleEl.toggleClass("is-disabled", this.disabled); }
  getValue(): boolean { return this.value; }
  setValue(on: boolean): this {
    this.value = !!on;
    this.toggleEl.toggleClass("is-enabled", this.value);
    this.toggleEl.setAttr("aria-checked", String(this.value));
    return this;
  }
  setTooltip(tip: string): this { this.toggleEl.setAttr("aria-label", tip); return this; }
  onChange(cb: (v: boolean) => unknown): this { this.changed = cb; return this; }
}

export class TextComponent extends BaseComponent {
  inputEl: HTMLInputElement;
  constructor(containerEl: HTMLElement) { super(); this.inputEl = containerEl.createEl("input", { attr: { type: "text", spellcheck: "false" } }); }
  protected applyDisabled(): void { this.inputEl.disabled = this.disabled; }
  getValue(): string { return this.inputEl.value; }
  setValue(v: string): this { this.inputEl.value = v ?? ""; return this; }
  setPlaceholder(p: string): this { this.inputEl.placeholder = p; return this; }
  onChange(cb: (v: string) => unknown): this { this.inputEl.addEventListener("input", () => void cb(this.inputEl.value)); return this; }
}

export class DropdownComponent extends BaseComponent {
  selectEl: HTMLSelectElement;
  constructor(containerEl: HTMLElement) { super(); this.selectEl = containerEl.createEl("select", { cls: "dropdown" }); }
  protected applyDisabled(): void { this.selectEl.disabled = this.disabled; }
  addOption(value: string, display: string): this { this.selectEl.createEl("option", { text: display, attr: { value } }); return this; }
  addOptions(options: Record<string, string>): this { for (const [v, d] of Object.entries(options)) this.addOption(v, d); return this; }
  getValue(): string { return this.selectEl.value; }
  setValue(v: string): this { this.selectEl.value = v; return this; }
  onChange(cb: (v: string) => unknown): this { this.selectEl.addEventListener("change", () => void cb(this.selectEl.value)); return this; }
}

export class Setting {
  settingEl: HTMLElement;
  infoEl: HTMLElement;
  nameEl: HTMLElement;
  descEl: HTMLElement;
  controlEl: HTMLElement;
  components: BaseComponent[] = [];

  constructor(containerEl: HTMLElement) {
    this.settingEl = containerEl.createDiv({ cls: "setting-item" });
    this.infoEl = this.settingEl.createDiv({ cls: "setting-item-info" });
    this.nameEl = this.infoEl.createDiv({ cls: "setting-item-name" });
    this.descEl = this.infoEl.createDiv({ cls: "setting-item-description" });
    this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
  }

  setName(name: string | DocumentFragment): this { this.nameEl.setText(name); return this; }
  setDesc(desc: string | DocumentFragment): this { this.descEl.setText(desc); return this; }
  setClass(cls: string): this { this.settingEl.addClass(cls); return this; }
  setTooltip(tip: string): this { this.settingEl.setAttr("title", tip); return this; }
  setHeading(): this { this.settingEl.addClass("setting-item-heading"); return this; }
  setDisabled(disabled: boolean): this {
    this.settingEl.toggleClass("is-disabled", disabled);
    for (const c of this.components) c.setDisabled(disabled);
    return this;
  }

  private add<T extends BaseComponent>(c: T, cb: (c: T) => unknown): this { this.components.push(c); cb(c); return this; }
  addButton(cb: (c: ButtonComponent) => unknown): this { return this.add(new ButtonComponent(this.controlEl), cb); }
  addExtraButton(cb: (c: ExtraButtonComponent) => unknown): this { return this.add(new ExtraButtonComponent(this.controlEl), cb); }
  addToggle(cb: (c: ToggleComponent) => unknown): this { return this.add(new ToggleComponent(this.controlEl), cb); }
  addText(cb: (c: TextComponent) => unknown): this { return this.add(new TextComponent(this.controlEl), cb); }
  addDropdown(cb: (c: DropdownComponent) => unknown): this { return this.add(new DropdownComponent(this.controlEl), cb); }

  then(cb: (s: this) => unknown): this { cb(this); return this; }
}
