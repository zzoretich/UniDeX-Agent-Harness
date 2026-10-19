// The light or dark theme the HUD is drawn in. The host owns the choice (the app follows macOS, or the user's override)
// and says it with body.theme-light / body.theme-dark, as Obsidian does; the HUD only reads that class, so it works
// whoever flips it. CSS follows on its own through the --udx-* tokens. Code that needs literal colours (xterm paints a
// canvas) reads THEMES[currentTheme()] and listens with onThemeChange().

import type { ITheme } from "@xterm/xterm";
import { THEMES, type ThemeName } from "./tokens";

/** The theme `doc` is drawn in. Dark when the host set neither class (the HUD was dark-only before UniDeX). */
export function currentTheme(doc: Document = document): ThemeName {
  return doc.body?.classList.contains("theme-light") ? "light" : "dark";
}

/** The literal token values of the current theme. */
export function themeTokens(doc: Document = document): (typeof THEMES)[ThemeName] {
  return THEMES[currentTheme(doc)];
}

/** xterm's colours for a theme (the --udx-term-* tokens). Also used by the app's setup terminal. */
export function xtermTheme(name: ThemeName): ITheme {
  const t = THEMES[name];
  return {
    background: t.termBackground,
    foreground: t.termForeground,
    cursor: t.termCursor,
    cursorAccent: t.termCursorAccent,
    selectionBackground: t.termSelectionBackground,
    black: t.termBlack,
    red: t.termRed,
    green: t.termGreen,
    yellow: t.termYellow,
    blue: t.termBlue,
    magenta: t.termMagenta,
    cyan: t.termCyan,
    white: t.termWhite,
    brightBlack: t.termBrightBlack,
    brightRed: t.termBrightRed,
    brightGreen: t.termBrightGreen,
    brightYellow: t.termBrightYellow,
    brightBlue: t.termBrightBlue,
    brightMagenta: t.termBrightMagenta,
    brightCyan: t.termBrightCyan,
    brightWhite: t.termBrightWhite,
  };
}

/** The terminal font stack: the bundled JetBrains Mono first. */
export const TERMINAL_FONT = "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace";

/** Calls `cb` with the new theme each time `doc`'s body switches theme; returns the unsubscribe function. */
export function onThemeChange(cb: (theme: ThemeName) => void, doc: Document = document): () => void {
  let last = currentTheme(doc);
  const observer = new MutationObserver(() => {
    const now = currentTheme(doc);
    if (now === last) return;
    last = now;
    cb(now);
  });
  observer.observe(doc.body, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}
