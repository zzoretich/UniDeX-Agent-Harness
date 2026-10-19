// Tripwire: fails when the Workbench HUD (../hud) imports a name from "obsidian", calls one of Obsidian's
// DOM helpers, or names an icon that compat does not provide. Run it after every change to hud/.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hud = path.join(root, "../hud");
const compat = path.join(root, "obsidian-compat/src");

// Obsidian's DOM helpers whose names cannot be confused with Array/Events/String methods.
const OBSIDIAN_DOM_HELPERS = [
  "createEl", "createDiv", "createSpan", "createSvg", "createFragment", "empty", "detach", "addClass", "addClasses",
  "removeClass", "removeClasses", "toggleClass", "hasClass", "setAttr", "setAttrs", "getAttr", "setText", "getText",
  "appendText", "setCssStyles", "setCssProps", "onClickEvent", "onNodeInserted", "findAll", "findAllSelf",
  "matchParent", "instanceOf", "insertAfter", "setChildrenInPlace", "toggleVisibility", "isShown",
];

function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (name === "node_modules" || name === "fixtures") continue;
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const hudFiles = [path.join(hud, "main.ts"), ...sources(path.join(hud, "src"))];
const hudText = hudFiles.map((f) => readFileSync(f, "utf8")).join("\n");

// Names the HUD imports from "obsidian" (type-only imports included: the compat package must export each name).
const imported = new Map();
for (const f of hudFiles) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(/import\s+(type\s+)?\{([^}]+)\}\s+from\s+["']obsidian["']/g)) {
    for (const raw of m[2].split(",")) {
      const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      if (!imported.has(name)) imported.set(name, []);
      imported.get(name).push(path.relative(hud, f));
    }
  }
}

// Names the compat layer exports from its index.
const indexText = readFileSync(path.join(compat, "index.ts"), "utf8");
const exported = new Set();
for (const m of indexText.matchAll(/export\s*\{([^}]+)\}/g)) {
  for (const raw of m[1].split(",")) {
    const parts = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
    const name = (parts[1] ?? parts[0]).trim();
    if (name) exported.add(name);
  }
}
for (const m of indexText.matchAll(/export\s+(?:const|class|function|interface|type)\s+(\w+)/g)) exported.add(m[1]);

// DOM helpers the compat layer installs.
const domText = readFileSync(path.join(compat, "dom.ts"), "utf8");
const installed = new Set([...domText.matchAll(/"(\w+)"/g)].map((m) => m[1]));

// Icon ids the HUD names (ribbon, view icons, setting buttons); compat renders them with lucide, as Obsidian does.
const { icons } = createRequire(import.meta.url)("lucide");
const ICON_ALIASES = { document: "file-text" };
const lucideName = (id) => id.split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
const iconIds = new Set();
for (const m of hudText.matchAll(/(?:addRibbonIcon|setIcon)\(([^)]*)\)/g)) for (const q of m[1].matchAll(/"([a-z0-9-]+)"/g)) iconIds.add(q[1]);
for (const m of hudText.matchAll(/getIcon\(\)[^{]*\{\s*return\s+"([a-z0-9-]+)"/g)) iconIds.add(m[1]);
// Tables of icons (the Workbench rail: `{ id, icon: "bell", label }`), which reach setIcon through a variable.
for (const m of hudText.matchAll(/\bicon:\s*"([a-z0-9-]+)"/g)) iconIds.add(m[1]);
const missingIcons = [...iconIds].filter((id) => !icons[lucideName(ICON_ALIASES[id] ?? id)]);

const missingImports = [...imported.keys()].filter((n) => !exported.has(n));
const usedHelpers = OBSIDIAN_DOM_HELPERS.filter((h) => new RegExp(`\\.${h}\\(`).test(hudText));
const missingHelpers = usedHelpers.filter((h) => !installed.has(h));

const hudVersion = JSON.parse(readFileSync(path.join(hud, "package.json"), "utf8")).version;
console.log(`Workbench HUD ${hudVersion}: ${imported.size} names imported from "obsidian", ${usedHelpers.length} Obsidian DOM helpers used`);
console.log(`imports:  ${[...imported.keys()].sort().join(", ")}`);
console.log(`helpers:  ${usedHelpers.join(", ")}`);
console.log(`icons:    ${[...iconIds].sort().join(", ")}`);

if (missingImports.length || missingHelpers.length || missingIcons.length) {
  for (const n of missingImports) console.error(`MISSING import "${n}" (used in ${imported.get(n).join(", ")})`);
  for (const h of missingHelpers) console.error(`MISSING DOM helper .${h}()`);
  for (const i of missingIcons) console.error(`MISSING icon "${i}" (not a lucide id)`);
  process.exit(1);
}
console.log("compat covers everything the HUD uses");
