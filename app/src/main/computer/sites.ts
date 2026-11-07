// Marked sites (agent-computer D25): origins the person has marked as ones an agent may act on without asking "unmarked",
// plus per-origin allowances for ask categories ("always allow merge here"). Local development hosts start marked.
// Stored at <userData>/computer/sites.json, written 0600 by temp file and rename.

import fs from "node:fs";
import path from "node:path";
import type { AskCategory } from "./categories";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

interface Store { schema: 1; origins: string[]; categories: Record<string, AskCategory[]> }

function originOf(x: string): string | null {
  try { const o = new URL(x).origin; return o === "null" ? null : o; } catch { return null; }
}

export class SiteMarks {
  constructor(private file: string) {}

  isMarked(url: string): boolean {
    let u: URL;
    try { u = new URL(url); } catch { return false; }
    if ((u.protocol === "http:" || u.protocol === "https:") && LOCAL_HOSTS.has(u.hostname)) return true;
    return this.read().origins.includes(u.origin);
  }

  mark(origin: string): void {
    const o = originOf(origin); if (!o) return;
    const s = this.read();
    if (!s.origins.includes(o)) { s.origins.push(o); this.write(s); }
  }

  unmark(origin: string): void {
    const o = originOf(origin); if (!o) return;
    const s = this.read();
    if (s.origins.includes(o)) { s.origins = s.origins.filter((x) => x !== o); this.write(s); }
  }

  list(): string[] { return [...this.read().origins]; }

  allowCategory(origin: string, c: AskCategory): void {
    const o = originOf(origin); if (!o) return;
    const s = this.read();
    const cur = s.categories[o] ?? [];
    if (!cur.includes(c)) { s.categories[o] = [...cur, c]; this.write(s); }
  }

  categoryAllowed(origin: string, c: AskCategory): boolean {
    const o = originOf(origin);
    return o ? (this.read().categories[o] ?? []).includes(c) : false;
  }

  private read(): Store {
    const empty: Store = { schema: 1, origins: [], categories: {} };
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<Store> | null;
      if (!j || typeof j !== "object") return empty;
      const origins = Array.isArray(j.origins) ? j.origins.filter((x): x is string => typeof x === "string") : [];
      const categories: Record<string, AskCategory[]> = {};
      if (j.categories && typeof j.categories === "object") {
        for (const [k, v] of Object.entries(j.categories)) if (Array.isArray(v)) categories[k] = v.filter((x): x is AskCategory => typeof x === "string");
      }
      return { schema: 1, origins, categories };
    } catch { return empty; }
  }

  private write(s: Store): void {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.sites-${process.pid}-${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
