import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import type * as Confirm from "./ConfirmModal";

// ConfirmModal draws into an Obsidian Modal: under node:test "obsidian" resolves to a stub whose Modal builds its
// modalEl and contentEl in a small fake DOM, with a field of the page behind it that has the keyboard when it opens
// (Merge's "Replace your edits?" lands while the person types in Body).
interface FakeDoc { activeElement: FakeEl | null; body: FakeEl | null }
type Opts = { cls?: string; text?: string; attr?: Record<string, string> };
class FakeEl {
  children: Array<FakeEl | string> = [];
  parent: FakeEl | null = null;
  attrs = new Map<string, string>();
  classes = new Set<string>();
  listeners = new Map<string, Array<(e: unknown) => void>>();
  constructor(public tagName: string, public ownerDocument: FakeDoc) {}
  createEl(tag: string, o: Opts = {}): FakeEl {
    const el = new FakeEl(tag.toUpperCase(), this.ownerDocument);
    for (const c of (o.cls ?? "").split(/\s+/).filter(Boolean)) el.classes.add(c);
    if (o.text !== undefined) el.children.push(o.text);
    for (const [k, v] of Object.entries(o.attr ?? {})) el.attrs.set(k, String(v));
    el.parent = this;
    this.children.push(el);
    return el;
  }
  createDiv(o: Opts = {}): FakeEl { return this.createEl("div", o); }
  empty(): void { this.children = []; }
  addClass(c: string): void { this.classes.add(c); }
  setAttr(k: string, v: string): void { this.attrs.set(k, String(v)); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; }
  addEventListener(type: string, fn: (e: unknown) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  click(): void { for (const fn of this.listeners.get("click") ?? []) fn({ preventDefault() {} }); }
  focus(): void { this.ownerDocument.activeElement = this; }
  get elements(): FakeEl[] { return this.children.filter((c): c is FakeEl => typeof c !== "string"); }
  get textContent(): string { return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join(""); }
  contains(x: FakeEl | null): boolean { for (let e: FakeEl | null = x; e; e = e.parent) if (e === this) return true; return false; }
  querySelectorAll(tag: string): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (e: FakeEl): void => { for (const c of e.elements) { if (c.tagName === tag.toUpperCase()) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
}

const doc: FakeDoc = { activeElement: null, body: null };
doc.body = new FakeEl("BODY", doc);

class FakeModal {
  modalEl: FakeEl;
  contentEl: FakeEl;
  constructor(public app: unknown) {
    this.modalEl = doc.body!.createDiv({ cls: "modal" });
    this.contentEl = this.modalEl.createDiv({ cls: "modal-content" });
  }
  open(): void { void (this as unknown as { onOpen(): void }).onOpen(); }
  close(): void { void (this as unknown as { onClose(): void }).onClose(); this.modalEl.remove(); }
}

const STUB = "obsidian-stub";
const M = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string };
const resolve = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "obsidian" ? STUB : resolve.call(this, request, ...rest);
};
class Stub {}
require.cache[STUB] = {
  id: STUB, filename: STUB, loaded: true,
  exports: { Modal: FakeModal, FuzzySuggestModal: Stub, App: Stub },
} as unknown as NodeJS.Module;

const { ConfirmModal } = require("./ConfirmModal") as typeof Confirm;

const flush = async (): Promise<void> => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };

test("a question is an alertdialog named by its title and described by its message, and Cancel takes the keyboard", async () => {
  doc.body!.children = [];
  const field = doc.body!.createEl("textarea");
  field.focus();
  let answer: boolean | null = null;
  void ConfirmModal.ask({} as never, "Replace your edits?", "The model's draft replaces the title, description and body you changed here.", "Replace").then((x) => { answer = x; });
  const modal = doc.body!.elements.find((e) => e.classes.has("modal"))!;
  assert.equal(modal.getAttribute("role"), "alertdialog");
  assert.equal(modal.getAttribute("aria-modal"), "true");
  const [h3] = modal.querySelectorAll("h3");
  const [p] = modal.querySelectorAll("p");
  assert.equal(h3.textContent, "Replace your edits?");
  assert.equal(modal.getAttribute("aria-labelledby"), h3.getAttribute("id"));
  assert.equal(modal.getAttribute("aria-describedby"), p.getAttribute("id"));
  const [cancel, ok] = modal.querySelectorAll("button");
  assert.deepEqual([cancel.textContent, ok.textContent], ["Cancel", "Replace"]);
  assert.deepEqual([cancel.getAttribute("type"), ok.getAttribute("type")], ["button", "button"]);
  assert.equal(doc.activeElement, cancel, "the keys go to the question, never the field behind it");
  cancel.click();
  await flush();
  assert.equal(answer, false);
});

test("confirm resolves true; the next question gets ids of its own", async () => {
  doc.body!.children = [];
  let answer: boolean | null = null;
  void ConfirmModal.ask({} as never, "Archive 1 memory?", "Archives it.", "Archive").then((x) => { answer = x; });
  const first = doc.body!.elements.find((e) => e.classes.has("modal"))!;
  const id = first.getAttribute("aria-labelledby");
  first.querySelectorAll("button")[1].click();
  await flush();
  assert.equal(answer, true);
  void ConfirmModal.ask({} as never, "Retitle?", "The heading changes.", "Retitle");
  const second = doc.body!.elements.find((e) => e.classes.has("modal"))!;
  assert.notEqual(second.getAttribute("aria-labelledby"), id);
});
