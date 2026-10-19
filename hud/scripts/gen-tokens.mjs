#!/usr/bin/env node
// Generates src/ui/tokens.ts from styles.css's `body.theme-light` and `body.theme-dark` --udx-* custom properties.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "styles.css"), "utf8");

/** The --udx-* properties of one theme block, camel-cased (--udx-ok-bg → okBg). */
function themeVars(name) {
  const block = css.match(new RegExp(`body\\.theme-${name}\\s*\\{([\\s\\S]*?)\\}`));
  if (!block) { console.error(`gen-tokens: no body.theme-${name} block found`); process.exit(1); }
  const vars = {};
  for (const m of block[1].matchAll(/--udx-([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    vars[m[1].replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())] = m[2].trim();
  }
  if (Object.keys(vars).length === 0) { console.error(`gen-tokens: zero vars parsed in theme-${name}`); process.exit(1); }
  return vars;
}

const light = themeVars("light");
const dark = themeVars("dark");
const missing = [...Object.keys(light).filter((k) => !(k in dark)), ...Object.keys(dark).filter((k) => !(k in light))];
if (missing.length) { console.error(`gen-tokens: the themes disagree on ${missing.join(", ")}`); process.exit(1); }

const body = (vars) => Object.keys(vars).sort().map((k) => `    ${k}: ${JSON.stringify(vars[k])},`).join("\n");
const out = `// AUTO-GENERATED from styles.css \`body.theme-light\` / \`body.theme-dark\` by scripts/gen-tokens.mjs — DO NOT EDIT.
// Regenerate: npm run gen:tokens
export const THEMES = {
  light: {
${body(light)}
  },
  dark: {
${body(dark)}
  },
} as const;
export type ThemeName = keyof typeof THEMES;
export type TokenName = keyof typeof THEMES.light;
`;
writeFileSync(join(root, "src", "ui", "tokens.ts"), out);
console.log(`gen-tokens: wrote ${Object.keys(light).length} tokens × 2 themes`);
