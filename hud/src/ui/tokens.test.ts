import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { THEMES, type ThemeName } from "./tokens";

const css = readFileSync(join(__dirname, "..", "..", "styles.css"), "utf8");

function fromCss(name: ThemeName): Record<string, string> {
  const block = css.match(new RegExp(`body\\.theme-${name}\\s*\\{([\\s\\S]*?)\\}`))![1];
  const vars: Record<string, string> = {};
  for (const m of block.matchAll(/--udx-([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    vars[m[1].replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = m[2].trim();
  }
  return vars;
}

/** WCAG 2 contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string): number => {
    const n = parseInt(hex.slice(1), 16);
    return [n >> 16, (n >> 8) & 255, n & 255]
      .map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("tokens.ts is in lockstep with styles.css (run npm run gen:tokens after CSS edits)", () => {
  assert.deepEqual(THEMES.light, fromCss("light"));
  assert.deepEqual(THEMES.dark, fromCss("dark"));
});

test("both themes define the same tokens", () => {
  assert.deepEqual(Object.keys(THEMES.light).sort(), Object.keys(THEMES.dark).sort());
});

test("the core tokens keep their UniDeX values", () => {
  assert.equal(THEMES.light.bg, "#ffffff");
  assert.equal(THEMES.light.text, "#0d0d0d");
  assert.equal(THEMES.dark.bg, "#0b0b0b");
  assert.equal(THEMES.dark.text, "#f2f2f2");
});

for (const name of ["light", "dark"] as const) {
  const t = THEMES[name];

  test(`${name}: body text stays 4.5:1 on every surface`, () => {
    for (const fg of ["text", "text2", "text3"] as const) {
      for (const bg of ["bg", "surface", "raised", "field"] as const) {
        assert.ok(contrast(t[fg], t[bg]) >= 4.5, `${fg} on ${bg}: ${contrast(t[fg], t[bg]).toFixed(2)}`);
      }
    }
    assert.ok(contrast(t.invText, t.inv) >= 4.5, "inverted button text");
  });

  test(`${name}: each status tone reads 4.5:1 on its own tint and on the page`, () => {
    for (const tone of ["ok", "warn", "danger", "info", "gate", "off"] as const) {
      const bgKey = `${tone}Bg` as const;
      assert.ok(contrast(t[tone], t[bgKey]) >= 4.5, `${tone} on ${bgKey}: ${contrast(t[tone], t[bgKey]).toFixed(2)}`);
      assert.ok(contrast(t[tone], t.bg) >= 4.5, `${tone} on bg: ${contrast(t[tone], t.bg).toFixed(2)}`);
      assert.ok(contrast(t[tone], t.surface) >= 4.5, `${tone} on surface: ${contrast(t[tone], t.surface).toFixed(2)}`);
    }
  });

  test(`${name}: terminal colours read 4.5:1 on the terminal background`, () => {
    const ansi = ["termForeground", "termRed", "termGreen", "termYellow", "termBlue", "termMagenta", "termCyan", "termWhite",
      "termBrightBlack", "termBrightRed", "termBrightGreen", "termBrightYellow", "termBrightBlue", "termBrightMagenta",
      "termBrightCyan", "termBrightWhite"] as const;
    for (const k of ansi) {
      assert.ok(contrast(t[k], t.termBackground) >= 4.5, `${k}: ${contrast(t[k], t.termBackground).toFixed(2)}`);
    }
  });

  test(`${name}: the terminal's text reads 4.5:1 on ⌘F's matches`, () => {
    for (const k of ["termFindMatch", "termFindActive"] as const) {
      assert.match(t[k], /^#[0-9a-f]{6}$/, `${k} is #rrggbb (xterm decorations take nothing else)`);
      assert.ok(contrast(t.termForeground, t[k]) >= 4.5, `termForeground on ${k}: ${contrast(t.termForeground, t[k]).toFixed(2)}`);
    }
  });

  test(`${name}: Pulse's rail icon reads 4.5:1 at rest, hovered and on the selected chip (spec 2026-10-09 D6)`, () => {
    for (const bg of ["bg", "raised"] as const) {
      assert.ok(contrast(t.pulse, t[bg]) >= 4.5, `pulse on ${bg}: ${contrast(t.pulse, t[bg]).toFixed(2)}`);
    }
    assert.ok(contrast(t.pulseOnInv, t.inv) >= 4.5, `pulseOnInv on inv: ${contrast(t.pulseOnInv, t.inv).toFixed(2)}`);
  });
}

test("Pulse is navy in light and neon blue in dark, and the selected chip takes the other theme's (spec 2026-10-09 D6)", () => {
  assert.equal(THEMES.light.pulse, "#1e3a8a");
  assert.equal(THEMES.dark.pulse, "#00b3ff");
  assert.equal(THEMES.light.pulseOnInv, THEMES.dark.pulse);
  assert.equal(THEMES.dark.pulseOnInv, THEMES.light.pulse);
});
