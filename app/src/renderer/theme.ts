// Light and dark on the page (UniDeX D6). Main resolves the user's choice against macOS's appearance; the page sets
// body.theme-light or body.theme-dark, which the --udx-* tokens key on (hud/styles.css), and color-scheme
// for the native controls. The tray popover is a document of this page's too, so it is themed the same way.

import type { AosBridge, ThemeSource, ThemeState } from "../shared/ipc";

/** How each choice reads in the menu, the settings tab and the toggle's tooltip. */
export const THEME_LABELS: Record<ThemeSource, string> = { system: "Match macOS", light: "Light", dark: "Dark" };

export function applyTheme(doc: Document, s: ThemeState): void {
  doc.body.classList.toggle("theme-dark", s.dark);
  doc.body.classList.toggle("theme-light", !s.dark);
  doc.documentElement.style.colorScheme = s.dark ? "dark" : "light";
}

/** A one-click toggle's next choice: the opposite of what shows now, as an explicit choice. */
export function toggledSource(s: ThemeState): ThemeSource { return s.dark ? "light" : "dark"; }

/** Keeps every document of this page in the current theme. */
export class PageTheme {
  private readonly docs = new Set<Document>();
  private readonly listeners = new Set<(s: ThemeState) => void>();

  constructor(private readonly aos: AosBridge, private current: ThemeState) {
    aos.theme.onChange((s) => {
      this.current = s;
      for (const d of this.docs) applyTheme(d, s);
      for (const cb of this.listeners) cb(s);
    });
  }

  get state(): ThemeState { return this.current; }

  /** Themes `doc` now and on every change. */
  track(doc: Document): void {
    this.docs.add(doc);
    applyTheme(doc, this.current);
  }

  onChange(cb: (s: ThemeState) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  set(source: ThemeSource): void {
    const r = this.aos.theme.set(source);
    if (!r.ok) console.warn(`[host] could not set the theme: ${r.error}`);
  }

  toggle(): void { this.set(toggledSource(this.current)); }
}
