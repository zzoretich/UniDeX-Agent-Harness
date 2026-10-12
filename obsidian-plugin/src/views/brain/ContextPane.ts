// Library's context, the right pane (spec 2026-10-11-brain-hub D2, D8, D11; canvas Library.dc.html): for the open file,
// its use over 30 days from the usage log (paths and counts only, D8), what links to it (found after the pane is drawn,
// a vault pass kept per file), the memories that score close to it (D11: by meaning with embeddings, else by words)
// and its history from the trail in one line with its path. Under 1100 px the pane folds under the reader.
import {
  hasUsage, historyFor, historyLine, hostSplit, linkSourceKind, nearby, nearbyBasis, shortDay, type HubUsageRow, sessionLabel,
} from "../../data/brainModel";
import { readerPath, focusedKey, refocus, type ReaderItem } from "./Reader";
import { MAX_BACKLINKS, type LibraryLinks } from "./LibraryLinks";
import type { BrainCtx } from "./types";

/** At or above this score a nearby memory reads amber: it may be the same memory twice (D11's flag is 0.8 by default). */
const CLOSE = 0.85;

export interface ContextHandlers {
  /** Show a file Library holds (a memory, a draft, a pattern, a reflection); anything else opens in the editor. */
  open(path: string): void;
}

export class LibraryContext {
  readonly el: HTMLElement;
  private sig = "";
  private path: string | null = null;
  private linksEl: HTMLElement | null = null;
  private linksDrawn = "";
  private last: { path: string; list: string[] } | null = null;
  private ask = 0;
  private tele: { load: object; on: boolean } | null = null;

  constructor(parent: HTMLElement, private ctx: BrainCtx, private links: LibraryLinks, private on: ContextHandlers) {
    this.el = parent.createEl("aside", { cls: "aos-brain-right aos-lib-context", attr: { "aria-label": "Context" } });
  }

  show(item: ReaderItem | null): void {
    const path = item ? readerPath(item) : null;
    const sig = item ? JSON.stringify(this.signature(item)) : "empty";
    if (sig !== this.sig) {
      this.sig = sig;
      const same = path === this.path;
      const top = same ? this.el.scrollTop : 0;
      const key = same ? focusedKey(this.el) : null;
      this.path = path;
      this.el.empty();
      this.linksEl = null;
      this.linksDrawn = "";
      if (!item) { this.el.createDiv({ cls: "aos-brain-empty", text: "Nothing open." }); return; }
      this.draw(item);
      this.el.scrollTop = top;
      refocus(this.el, key);
    }
    if (path) this.fillLinks(path);
  }

  private signature(it: ReaderItem): unknown[] {
    const d = this.ctx.data();
    const path = readerPath(it);
    const u = d.hub?.usage.paths[path] ?? null;
    const base: unknown[] = [it.kind, path, hasUsage(d.hub), d.hub?.usage.since ?? null, u, this.telemetryOn()];
    if (it.kind !== "memories") return [...base, it.kind === "drafts" ? [it.d.created, it.d.session] : [it.n.created, it.n.updated]];
    return [...base, nearbyBasis(d.pairs, path), nearby(d.pairs, path, d.byPath), historyLine(historyFor(d.trail, it.m), it.m, d.now)];
  }

  /** telemetry.enabled, read once per load (it reads the config files, and show() runs on every keystroke). */
  private telemetryOn(): boolean {
    const d = this.ctx.data();
    if (this.tele?.load !== d) {
      let on = true;
      try { on = this.ctx.plugin.telemetryOn(); } catch { /* unknown: say nothing about it */ }
      this.tele = { load: d, on };
    }
    return this.tele.on;
  }

  private section(title: string, key: string, sub?: string): HTMLElement {
    const s = this.el.createEl("section", { cls: "aos-lib-csec", attr: { "data-section": key } });
    const h = s.createEl("h3", { cls: "aos-brain-label aos-lib-chead" });
    h.createSpan({ text: title });
    if (sub) h.createSpan({ cls: "aos-brain-mono aos-lib-csub", text: sub });
    return s;
  }

  private draw(it: ReaderItem): void {
    const d = this.ctx.data();
    const path = readerPath(it);
    // Use: memories and patterns are logged (D8); drafts and reflections never reach an agent through recall.
    if (it.kind === "memories" || it.kind === "patterns") this.use(path);
    this.linksEl = this.section("LINKED FROM", "links");
    if (it.kind === "memories") {
      const near = nearby(d.pairs, path, d.byPath);
      const basis = nearbyBasis(d.pairs, path);
      const s = this.section("NEARBY", "nearby", basis ? `by ${basis}` : undefined);
      if (!near.length) s.createDiv({ cls: "aos-lib-cnote", text: "Nothing scores close to this one." });
      for (const n of near) {
        const b = s.createEl("button", { cls: "aos-lib-clink", attr: { "data-path": n.path, "data-lib-key": `near:${n.path}`, title: `${n.title}: score ${n.score.toFixed(2)}` } });
        b.createSpan({ cls: "aos-lib-clinkt", text: n.title });
        b.createSpan({ cls: `aos-brain-mono aos-lib-score${n.score >= CLOSE ? " is-close" : ""}`, text: n.score.toFixed(2) });
        b.addEventListener("click", () => this.on.open(n.path));
      }
    }
    const h = this.section("HISTORY", "history");
    let line: string;
    if (it.kind === "memories") line = historyLine(historyFor(d.trail, it.m), it.m, d.now);
    else {
      const c = shortDay(it.kind === "drafts" ? it.d.created : it.n.created, d.now);
      const u = it.kind === "drafts" ? "" : shortDay(it.n.updated, d.now);
      line = [c ? `${it.kind === "drafts" ? "Drafted" : "Created"} ${c}` : "", u && u !== c ? `updated ${u}` : "",
        it.kind === "drafts" && it.d.session ? sessionLabel(it.d.session) : ""].filter(Boolean).join(" · ");
    }
    h.createEl("p", { cls: "aos-lib-cline", text: line || "Nothing in the trail for it yet." });
    h.createEl("p", { cls: "aos-brain-mono aos-lib-cpath", text: path });
  }

  /** USE · LAST 30 DAYS (D8): the 30-day and 7-day counts, how it was reached, by which host; or why there is none. */
  private use(path: string): void {
    const d = this.ctx.data();
    const s = this.section("USE · LAST 30 DAYS", "use");
    const on = this.telemetryOn();
    // Off: the reason, and no counts from a log written before it was turned off (spec §5.6, as Health and Map).
    if (!on) { s.createEl("p", { cls: "aos-lib-cnote", text: "Telemetry is off in this vault, so no use is logged (Settings, telemetry.enabled)." }); return; }
    if (!hasUsage(d.hub)) {
      s.createEl("p", { cls: "aos-lib-cnote", text: "No usage yet: the log starts with the next session." });
      return;
    }
    const u: HubUsageRow = d.hub!.usage.paths[path] ?? { d7: 0, d30: 0, last: null, injected: 0, recalled: 0, read: 0, claude: 0, codex: 0 };
    const stats = s.createDiv({ cls: "aos-lib-stats" });
    const stat = (n: number, label: string, key: string): void => {
      const c = stats.createDiv({ cls: "aos-lib-stat", attr: { "data-stat": key } });
      c.createSpan({ cls: `aos-brain-mono aos-lib-statn${key === "d30" && n === 0 ? " is-unused" : ""}`, text: String(n) });
      c.createSpan({ cls: "aos-lib-statl", text: label });
    };
    stat(u.d30, "uses in 30 days", "d30");
    stat(u.d7, "this week", "d7");
    const since = shortDay(d.hub!.usage.since, d.now);
    const how = [u.injected ? `injected ${u.injected}` : "", u.recalled ? `recalled ${u.recalled}` : "", u.read ? `read ${u.read}` : ""].filter(Boolean).join(" · ");
    s.createEl("p", { cls: "aos-lib-cline", text: how ? `${how}${since ? ` since ${since}` : ""}` : `Not used${since ? ` since the log began ${since}` : " yet"}.` });
    const hosts = hostSplit(u);
    if (hosts) s.createEl("p", { cls: "aos-lib-cline aos-brain-mono", text: hosts });
    const last = shortDay(u.last, d.now);
    if (last) s.createEl("p", { cls: "aos-lib-cline", text: `Last used ${last}` });
  }

  /** LINKED FROM <n>: drawn from what is known now (the last answer for this file while a new load asks again). */
  private fillLinks(path: string): void {
    const d = this.ctx.data();
    const known = this.links.known(path, d);
    if (known) { this.drawLinks(path, known); return; }
    this.drawLinks(path, this.last?.path === path ? this.last.list : null);
    const ask = ++this.ask;
    void this.links.backlinks(path, d).then(
      (list) => { if (ask === this.ask && this.path === path) { this.last = { path, list }; this.drawLinks(path, list); } },
      () => { if (ask === this.ask && this.path === path) this.drawLinks(path, []); },
    );
  }

  private drawLinks(path: string, list: string[] | null): void {
    const s = this.linksEl;
    if (!s) return;
    const sig = list ? `${path}\n${list.join("\n")}` : `${path}\n…`;
    if (sig === this.linksDrawn) return;
    this.linksDrawn = sig;
    const key = focusedKey(s);
    const head = s.querySelector<HTMLElement>(".aos-lib-chead");
    for (const c of Array.from(s.children)) if (c !== head) c.remove();
    head?.querySelector(".aos-lib-csub")?.remove();
    head?.createSpan({ cls: "aos-brain-mono aos-lib-csub", text: list ? `${list.length}${list.length >= MAX_BACKLINKS ? "+" : ""}` : "…" });
    if (!list) { s.createDiv({ cls: "aos-lib-cnote", text: "Looking through the vault…" }); return; }
    if (!list.length) { s.createDiv({ cls: "aos-lib-cnote", text: "Nothing links here." }); return; }
    const d = this.ctx.data();
    for (const p of list) {
      const kind = linkSourceKind(p);
      const title = d.byPath.get(p)?.title ?? d.drafts.find((x) => x.path === p)?.title ?? d.patterns.find((x) => x.path === p)?.title
        ?? d.reflections.find((x) => x.path === p)?.title ?? p.slice(p.lastIndexOf("/") + 1);
      const b = s.createEl("button", { cls: "aos-lib-clink", attr: { "data-path": p, "data-lib-key": `link:${p}`, title: p } });
      b.createSpan({ cls: "aos-lib-clinkt", text: title });
      b.createSpan({ cls: "aos-brain-mono aos-lib-ckind", text: kind });
      b.addEventListener("click", () => this.on.open(p));
    }
    if (list.length >= MAX_BACKLINKS) s.createDiv({ cls: "aos-lib-cnote", text: `The first ${MAX_BACKLINKS} files that link here.` });
    refocus(s, key);
  }

  destroy(): void {
    this.ask++;
    this.el.empty();
    this.sig = "";
    this.path = null;
    this.linksEl = null;
    this.linksDrawn = "";
  }
}
