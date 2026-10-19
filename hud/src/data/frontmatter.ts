// Hand-rolled YAML-ish frontmatter parser, ported from dashboards/serve.js so
// the plugin's filesystem-first readers produce identical shapes to the legacy
// HTTP API. Handles scalar key:value pairs, quoted strings, and block lists
// (subsequent `- item` lines). Anything more exotic falls through as a string.

export type FrontmatterValue = string | string[];
export type Frontmatter = Record<string, FrontmatterValue>;

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/;

export function extractFrontmatterBlock(text: string): string | null {
  const m = FRONTMATTER_RE.exec(text);
  return m ? m[1] : null;
}

export function parseFrontmatter(text: string): Frontmatter {
  const block = extractFrontmatterBlock(text);
  if (block == null) return {};
  const out: Frontmatter = {};
  const lines = block.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) { i++; continue; }
    const key = kv[1];
    let val = kv[2];
    if (val === "" || val == null) {
      // Possible block list: `- item` rows on subsequent lines
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
        items.push(lines[j].replace(/^\s*-\s+/, "").trim().replace(/^["']|["']$/g, ""));
        j++;
      }
      out[key] = items.length ? items : "";
      i = j;
      continue;
    }
    val = val.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
    i++;
  }
  return out;
}

export function firstLine(s: unknown, max = 240): string {
  if (s == null) return "";
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

export function asStringList(v: FrontmatterValue | undefined): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.filter(Boolean);
  return String(v).split(",").map((s) => s.trim()).filter(Boolean);
}
