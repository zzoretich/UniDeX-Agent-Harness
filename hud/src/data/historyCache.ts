// historyCache.ts — the Code sidebar's past conversations (spec 2026-11-09 code-chat C6): the same rows as Sessions ▸
// History (sessionHistory.ts), from the runtime's two caches, parsed again only when one of them changed. Never a
// transcript. `refresh()` stats the two files and calls `onChange` when the rows differ. In the app every fs call here is
// synchronous IPC to main (`fs.promises` too, behind its promise), and the sidebar renders on every terminal update (an
// animated title sends several a second), so a refresh checks at most every CHECK_MS unless forced (the Code tab shown
// again, I3).
import { fs } from "../host";
import * as path from "path";
import {
  SESSION_DIGESTS_PATH, SESSION_INDEX_PATH, historyRows, parseDigests, parseSessionIndex,
  type Digest, type HistoryRow, type IndexedSession,
} from "./sessionHistory";
import type { PlaceWorld, TermHostChoice } from "./terminalLaunch";

/** How often a refresh looks at the caches (and the hosts) at most, unless forced. */
export const CHECK_MS = 2000;

export interface HistorySources {
  vault(): string;
  /** The hosts and places as they are now: a login or a new workspace changes a row's Resume. */
  hosts(): { choices: TermHostChoice[]; world: PlaceWorld };
  /** The clock (tests); default Date.now. */
  now?(): number;
}

export class HistoryCache {
  private data: { stamp: string; sessions: IndexedSession[]; digests: Map<string, Digest> } | null = null;
  private built = "";
  private current: HistoryRow[] = [];
  private seq = 0;
  /** When refresh last looked, or null before the first look. */
  private checkedAt: number | null = null;

  constructor(private readonly src: HistorySources, private readonly onChange: () => void) {}

  rows(): HistoryRow[] { return this.current; }

  /** Looks at the caches again when CHECK_MS passed since the last look, or at once when `force`d. */
  refresh(force = false): void {
    const now = this.src.now ? this.src.now() : Date.now();
    if (!force && this.checkedAt !== null && now - this.checkedAt < CHECK_MS) return;
    this.checkedAt = now;
    const vault = this.src.vault();
    const files = [SESSION_INDEX_PATH, SESSION_DIGESTS_PATH].map((rel) => path.join(vault, rel));
    const stamp = files.map((f) => { try { const st = fs.statSync(f); return `${st.mtimeMs}:${st.size}`; } catch { return "-"; } }).join("|");
    if (this.data && this.data.stamp === stamp) { this.rebuild(); return; }
    const seq = ++this.seq;
    void (async () => {
      let failed = false;
      const read = async (f: string): Promise<string | null> => {
        try { return fs.existsSync(f) ? await fs.promises.readFile(f, "utf8") : null; } catch { failed = true; return null; }
      };
      const [index, digests] = await Promise.all(files.map(read));
      if (seq !== this.seq) return;
      // A read that failed is tried again at the next refresh.
      this.data = { stamp: failed ? "" : stamp, sessions: parseSessionIndex(index), digests: parseDigests(digests) };
      this.rebuild();
    })();
  }

  private rebuild(): void {
    if (!this.data) return;
    let hosts: ReturnType<HistorySources["hosts"]>;
    try { hosts = this.src.hosts(); } catch { hosts = { choices: [], world: { vault: this.src.vault(), home: "", workspaces: [], links: {} } }; }
    const sig = `${this.data.stamp}|${JSON.stringify(hosts.choices)}|${hosts.world.workspaces.join(",")}|${JSON.stringify(hosts.world.links)}`;
    if (sig === this.built) return;
    this.built = sig;
    this.current = historyRows(this.data.sessions, this.data.digests, hosts.choices, hosts.world);
    this.onChange();
  }
}
