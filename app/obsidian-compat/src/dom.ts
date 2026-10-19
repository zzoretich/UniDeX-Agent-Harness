// Obsidian's DOM helpers. Obsidian adds these to the DOM prototypes as globals, so the HUD calls them without imports
// (el.createDiv, el.empty, el.addClass, …). This file installs the subset the HUD uses, with Obsidian's signatures.

export interface DomElementInfo {
  cls?: string | string[];
  text?: string | DocumentFragment;
  attr?: Record<string, string | number | boolean | null | undefined>;
  title?: string;
  parent?: Node;
  value?: string;
  type?: string;
  prepend?: boolean;
  placeholder?: string;
  href?: string;
}

/** Every helper name installed here; scripts/check-compat.mjs reads this list. */
export const DOM_HELPERS = [
  "createEl", "createDiv", "createSpan", "createSvg", "createFragment",
  "empty", "detach", "addClass", "addClasses", "removeClass", "removeClasses", "toggleClass", "hasClass",
  "setAttr", "setAttrs", "getAttr", "setText", "getText", "appendText",
  "show", "hide", "toggle", "isShown", "setCssStyles", "setCssProps", "find", "findAll", "instanceOf",
] as const;

type Info = DomElementInfo | string | undefined;
type Cb<T> = ((el: T) => void) | undefined;

function splitCls(c: string | string[]): string[] {
  return (Array.isArray(c) ? c : [c]).flatMap((s) => String(s).split(/\s+/)).filter(Boolean);
}

function applyInfo(el: Element, o: Info): void {
  if (o === undefined) return;
  if (typeof o === "string") { if (o) el.classList.add(...splitCls(o)); return; }
  if (o.cls) el.classList.add(...splitCls(o.cls));
  if (o.text !== undefined) {
    if (typeof o.text === "string") el.textContent = o.text;
    else el.appendChild(o.text);
  }
  if (o.attr) for (const [k, v] of Object.entries(o.attr)) setAttrOn(el, k, v);
  if (o.title !== undefined) el.setAttribute("title", o.title);
  if (o.value !== undefined && "value" in el) (el as HTMLInputElement).value = o.value;
  if (o.type !== undefined) el.setAttribute("type", o.type);
  if (o.placeholder !== undefined) el.setAttribute("placeholder", o.placeholder);
  if (o.href !== undefined) el.setAttribute("href", o.href);
}

function setAttrOn(el: Element, name: string, value: unknown): void {
  if (value === null || value === undefined || value === false) el.removeAttribute(name);
  else el.setAttribute(name, value === true ? "" : String(value));
}

function place(parent: Node, el: Node, o: Info): void {
  const target = typeof o === "object" && o.parent ? o.parent : parent;
  if (typeof o === "object" && o.prepend) target.insertBefore(el, target.firstChild);
  else target.appendChild(el);
}

export function createEl<K extends keyof HTMLElementTagNameMap>(tag: K, o?: Info, cb?: Cb<HTMLElementTagNameMap[K]>): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyInfo(el, o);
  if (typeof o === "object" && o.parent) place(o.parent, el, o);
  cb?.(el);
  return el;
}
export function createDiv(o?: Info, cb?: Cb<HTMLDivElement>): HTMLDivElement { return createEl("div", o, cb); }
export function createSpan(o?: Info, cb?: Cb<HTMLSpanElement>): HTMLSpanElement { return createEl("span", o, cb); }
export function createSvg<K extends keyof SVGElementTagNameMap>(tag: K, o?: Info, cb?: Cb<SVGElementTagNameMap[K]>): SVGElementTagNameMap[K] {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  applyInfo(el, o);
  cb?.(el);
  return el;
}
export function createFragment(cb?: (f: DocumentFragment) => void): DocumentFragment {
  const f = document.createDocumentFragment();
  cb?.(f);
  return f;
}

let installed = false;

/** Installs the helpers on the DOM prototypes and as globals. Safe to call twice; a no-op outside a DOM. */
export function installDomHelpers(): void {
  if (installed || typeof Node === "undefined") return;
  installed = true;
  const N = Node.prototype as any;
  const E = Element.prototype as any;
  const H = HTMLElement.prototype as any;

  N.createEl = function (tag: string, o?: Info, cb?: Cb<HTMLElement>) {
    const el = document.createElement(tag);
    applyInfo(el, o);
    place(this, el, o);
    cb?.(el);
    return el;
  };
  N.createDiv = function (o?: Info, cb?: Cb<HTMLElement>) { return this.createEl("div", o, cb); };
  N.createSpan = function (o?: Info, cb?: Cb<HTMLElement>) { return this.createEl("span", o, cb); };
  N.createSvg = function (tag: string, o?: Info, cb?: Cb<SVGElement>) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    applyInfo(el, o);
    place(this, el, o);
    cb?.(el);
    return el;
  };
  N.empty = function () { while (this.firstChild) this.removeChild(this.firstChild); };
  N.detach = function () { this.parentNode?.removeChild(this); };
  N.appendText = function (val: string) { this.appendChild(document.createTextNode(val)); };
  N.instanceOf = function (type: any) { return this instanceof type; };

  E.addClass = function (...cls: string[]) { this.classList.add(...splitCls(cls)); };
  E.addClasses = function (cls: string[]) { this.classList.add(...splitCls(cls)); };
  E.removeClass = function (...cls: string[]) { this.classList.remove(...splitCls(cls)); };
  E.removeClasses = function (cls: string[]) { this.classList.remove(...splitCls(cls)); };
  E.toggleClass = function (cls: string | string[], value: boolean) {
    for (const c of splitCls(cls)) this.classList.toggle(c, value);
  };
  E.hasClass = function (cls: string) { return this.classList.contains(cls); };
  E.setAttr = function (name: string, value: unknown) { setAttrOn(this, name, value); };
  E.setAttrs = function (obj: Record<string, unknown>) { for (const [k, v] of Object.entries(obj)) setAttrOn(this, k, v); };
  E.getAttr = function (name: string) { return this.getAttribute(name); };
  E.setText = function (val: string | DocumentFragment) {
    if (typeof val === "string") this.textContent = val;
    else { this.empty(); this.appendChild(val); }
  };
  E.getText = function () { return this.textContent ?? ""; };
  E.find = function (sel: string) { return this.querySelector(sel); };
  E.findAll = function (sel: string) { return Array.from(this.querySelectorAll(sel)); };

  H.show = function () { this.style.display = ""; };
  H.hide = function () { this.style.display = "none"; };
  H.toggle = function (show: boolean) { this.style.display = show ? "" : "none"; };
  H.isShown = function () { return !!this.offsetParent; };
  H.setCssStyles = function (styles: Record<string, string>) { Object.assign(this.style, styles); };
  H.setCssProps = function (props: Record<string, string>) { for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v); };

  const g = globalThis as any;
  g.createEl = createEl;
  g.createDiv = createDiv;
  g.createSpan = createSpan;
  g.createSvg = createSvg;
  g.createFragment = createFragment;
}
