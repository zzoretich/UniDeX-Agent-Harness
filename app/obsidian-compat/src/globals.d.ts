// Types for the DOM helpers dom.ts installs on the prototypes and as globals, with Obsidian's signatures.

import type { DomElementInfo } from "./dom";

type Info = DomElementInfo | string;

declare global {
  interface Node {
    createEl<K extends keyof HTMLElementTagNameMap>(tag: K, o?: Info, cb?: (el: HTMLElementTagNameMap[K]) => void): HTMLElementTagNameMap[K];
    createDiv(o?: Info, cb?: (el: HTMLDivElement) => void): HTMLDivElement;
    createSpan(o?: Info, cb?: (el: HTMLSpanElement) => void): HTMLSpanElement;
    createSvg<K extends keyof SVGElementTagNameMap>(tag: K, o?: Info, cb?: (el: SVGElementTagNameMap[K]) => void): SVGElementTagNameMap[K];
    empty(): void;
    detach(): void;
    appendText(val: string): void;
    instanceOf<T>(type: new (...args: any[]) => T): this is T;
  }

  interface Element {
    addClass(...cls: string[]): void;
    addClasses(cls: string[]): void;
    removeClass(...cls: string[]): void;
    removeClasses(cls: string[]): void;
    toggleClass(cls: string | string[], value: boolean): void;
    hasClass(cls: string): boolean;
    setAttr(name: string, value: string | number | boolean | null | undefined): void;
    setAttrs(obj: Record<string, string | number | boolean | null | undefined>): void;
    getAttr(name: string): string | null;
    setText(val: string | DocumentFragment): void;
    getText(): string;
    find(selector: string): HTMLElement | null;
    findAll(selector: string): HTMLElement[];
  }

  interface HTMLElement {
    show(): void;
    hide(): void;
    toggle(show: boolean): void;
    isShown(): boolean;
    setCssStyles(styles: Partial<CSSStyleDeclaration>): void;
    setCssProps(props: Record<string, string>): void;
  }

  function createEl<K extends keyof HTMLElementTagNameMap>(tag: K, o?: Info, cb?: (el: HTMLElementTagNameMap[K]) => void): HTMLElementTagNameMap[K];
  function createDiv(o?: Info, cb?: (el: HTMLDivElement) => void): HTMLDivElement;
  function createSpan(o?: Info, cb?: (el: HTMLSpanElement) => void): HTMLSpanElement;
  function createSvg<K extends keyof SVGElementTagNameMap>(tag: K, o?: Info, cb?: (el: SVGElementTagNameMap[K]) => void): SVGElementTagNameMap[K];
  function createFragment(cb?: (f: DocumentFragment) => void): DocumentFragment;
}

export {};
