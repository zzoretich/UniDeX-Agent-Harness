// Obsidian's Vault and its DataAdapter over one vault root, through the bridge to main (bridge.ts), which reads and
// writes the disk and checks each write against the write surfaces (phase 4). A write main refuses is recorded in the
// guard log with the adapter's own name for it ("write TODO.md") and thrown as EROFS.
//
// Events: changed paths arrive from the main process's watcher and become create/modify/delete in Obsidian's shape.
// The runtime writes shared files atomically (write a temp file, rename it over the target), which a watcher reports as
// a rename; the startup index of known paths (one walk in main, with each file's stats) is what lets that surface as
// `modify`, the event the HUD listens for.

import * as path from "../../src/renderer/shims/path";
import type { Result, StatInfo } from "../../src/shared/ipc";
import { bridge, callError } from "./bridge";
import { Events, type EventRef } from "./events";
import { TAbstractFile, TFile, TFolder, normalizePath, type FileStats } from "./files";
import { refuse } from "./guard";
import { isIgnored } from "./ignore";

export { isIgnored };

/** Delivers batches of changed vault-relative paths; returns an unsubscribe function. */
export type ChangeFeed = (onPaths: (paths: string[]) => void) => () => void;

function toStats(s: StatInfo): FileStats { return { ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size }; }

export interface ListedFiles { files: string[]; folders: string[] }

/** The bytes of one ranged read; a file larger than this is read in several. */
const CHUNK = 8 * 1024 * 1024;

/** A write's answer: nothing when it went through; main's refusal, recorded as `what`, or its error, thrown. */
function wrote(r: Result<null>, what: string): void {
  if (r.ok) return;
  throw r.code === "EROFS" ? refuse("write", what) : callError(r, what);
}

export class DataAdapter {
  constructor(private readonly base: string) {}

  getBasePath(): string { return this.base; }
  getName(): string { return path.basename(this.base); }
  getFullPath(p: string): string { return this.abs(p); }

  private abs(p: string): string {
    const n = normalizePath(p);
    return n === "/" ? this.base : path.join(this.base, n);
  }

  async exists(p: string): Promise<boolean> {
    const r = bridge().fs.exists(this.abs(p));
    return r.ok && r.data;
  }

  async stat(p: string): Promise<(FileStats & { type: "file" | "folder" }) | null> {
    const r = bridge().fs.stat(this.abs(p));
    return r.ok ? { type: r.data.dir ? "folder" : "file", ...toStats(r.data) } : null;
  }

  async read(p: string): Promise<string> {
    const r = bridge().fs.readText(this.abs(p));
    if (!r.ok) throw callError(r, `read ${normalizePath(p)}`);
    return r.data;
  }

  async readBinary(p: string): Promise<ArrayBuffer> {
    const abs = this.abs(p);
    const st = bridge().fs.stat(abs);
    if (!st.ok) throw callError(st, `read ${normalizePath(p)}`);
    const out = new Uint8Array(st.data.size);
    for (let at = 0; at < out.length;) {
      const r = bridge().fs.readBytes(abs, at, Math.min(CHUNK, out.length - at));
      if (!r.ok) throw callError(r, `read ${normalizePath(p)}`);
      if (!r.data.length) break;
      out.set(r.data, at);
      at += r.data.length;
    }
    return out.buffer;
  }

  async list(p: string): Promise<ListedFiles> {
    const n = normalizePath(p);
    const prefix = n === "/" ? "" : `${n}/`;
    const r = bridge().fs.readdir(this.abs(p));
    if (!r.ok) throw callError(r, `list ${n}`);
    const out: ListedFiles = { files: [], folders: [] };
    for (const e of r.data) (e.dir ? out.folders : out.files).push(prefix + e.name);
    return out;
  }

  /** Writes a file, creating the folders above it (main checks the file and each new folder). */
  async write(p: string, data: string): Promise<void> {
    wrote(bridge().fs.writeText(this.abs(p), data, "hud"), `write ${normalizePath(p)}`);
  }

  async append(p: string, data: string): Promise<void> {
    wrote(bridge().fs.appendText(this.abs(p), data), `append ${normalizePath(p)}`);
  }

  async process(p: string, fn: (data: string) => string): Promise<string> {
    const next = fn(await this.read(p));
    wrote(bridge().fs.writeText(this.abs(p), next, "hud"), `process ${normalizePath(p)}`);
    return next;
  }

  async mkdir(p: string): Promise<void> {
    wrote(bridge().fs.mkdir(this.abs(p), true), `mkdir ${normalizePath(p)}`);
  }

  async remove(p: string): Promise<void> {
    wrote(bridge().fs.remove(this.abs(p), false), `remove ${normalizePath(p)}`);
  }

  async rmdir(p: string, recursive: boolean): Promise<void> {
    wrote(bridge().fs.remove(this.abs(p), recursive), `rmdir ${normalizePath(p)}`);
  }

  /** Moves a file or folder to the macOS Trash (Obsidian's `trash(file, true)`); the user can put it back from there. */
  async trashSystem(p: string): Promise<void> {
    wrote(await bridge().fs.trash(this.abs(p)), `trash ${normalizePath(p)}`);
  }

  /** A rename needs both ends to be writable. */
  async rename(from: string, to: string): Promise<void> {
    wrote(bridge().fs.rename(this.abs(from), this.abs(to)), `rename ${normalizePath(from)} → ${normalizePath(to)}`);
  }

  async copy(from: string, to: string): Promise<void> {
    wrote(bridge().fs.copy(this.abs(from), this.abs(to)), `copy ${normalizePath(from)} → ${normalizePath(to)}`);
  }
}

export class Vault extends Events {
  readonly adapter: DataAdapter;
  readonly configDir = ".obsidian";
  /** Every indexed file and its stats (Obsidian's in-memory file list). */
  private known = new Map<string, FileStats>();
  private indexed = false;
  private unsubscribe: (() => void) | null = null;

  constructor(base: string) {
    super();
    this.adapter = new DataAdapter(base);
  }

  getName(): string { return this.adapter.getName(); }
  getRoot(): TFolder { return new TFolder(this, "/"); }

  on(name: "create" | "modify" | "delete" | "rename" | "closed" | string, callback: (...data: any[]) => any, ctx?: any): EventRef {
    return super.on(name, callback, ctx);
  }

  // ── lookup ──────────────────────────────────────────────────────────

  private statOf(rel: string): StatInfo | null {
    const r = bridge().fs.stat(this.adapter.getFullPath(rel));
    return r.ok ? r.data : null;
  }

  getAbstractFileByPath(p: string): TAbstractFile | null {
    const n = normalizePath(p);
    if (n === "/") return this.getRoot();
    const s = this.statOf(n);
    if (!s) return null;
    return s.dir ? new TFolder(this, n) : new TFile(this, n, toStats(s));
  }
  getFileByPath(p: string): TFile | null {
    const f = this.getAbstractFileByPath(p);
    return f instanceof TFile ? f : null;
  }
  getFolderByPath(p: string): TFolder | null {
    const f = this.getAbstractFileByPath(p);
    return f instanceof TFolder ? f : null;
  }

  listChildren(folder: string): TAbstractFile[] {
    const prefix = folder === "/" ? "" : `${folder}/`;
    const r = bridge().fs.readdir(this.adapter.getFullPath(folder));
    if (!r.ok) return [];
    const out: TAbstractFile[] = [];
    for (const e of r.data) {
      if (isIgnored(e.name)) continue;
      // A plain folder needs no stats; a file, or a link (what it points at decides), is looked up.
      const f = e.dir && !e.link ? new TFolder(this, prefix + e.name) : this.getAbstractFileByPath(prefix + e.name);
      if (f) out.push(f);
    }
    return out;
  }

  /** Every indexed file, from the index's stats (no call per file). Built on first use by one walk of the vault in main. */
  getFiles(): TFile[] {
    this.ensureIndex();
    return [...this.known].map(([rel, stats]) => new TFile(this, rel, stats));
  }
  getMarkdownFiles(): TFile[] { return this.getFiles().filter((f) => f.extension === "md"); }
  getAllLoadedFiles(): TAbstractFile[] { return this.getFiles(); }

  async read(file: TFile): Promise<string> { return this.adapter.read(file.path); }
  async cachedRead(file: TFile): Promise<string> { return this.adapter.read(file.path); }

  // ── writes (each checked by main against the write surfaces) ───────

  async create(p: string, data: string): Promise<TFile> {
    const n = normalizePath(p);
    if (await this.adapter.exists(n)) throw new Error(`File already exists: ${n}`);
    await this.adapter.write(n, data);
    return this.getFileByPath(n)!;
  }
  async createFolder(p: string): Promise<TFolder> {
    await this.adapter.mkdir(p);
    return this.getFolderByPath(p)!;
  }
  async modify(file: TFile, data: string): Promise<void> { await this.adapter.write(file.path, data); }
  async append(file: TFile, data: string): Promise<void> { await this.adapter.append(file.path, data); }
  async process(file: TFile, fn: (data: string) => string): Promise<string> { return this.adapter.process(file.path, fn); }
  async delete(file: TAbstractFile): Promise<void> { await this.adapter.remove(file.path); }
  /** `system` true (what the HUD passes) moves it to the macOS Trash. false deletes it: Obsidian would use the vault's .trash folder, which the app does not keep. */
  async trash(file: TAbstractFile, system = true): Promise<void> {
    if (system) await this.adapter.trashSystem(file.path);
    else await this.adapter.remove(file.path);
  }
  async rename(file: TAbstractFile, to: string): Promise<void> { await this.adapter.rename(file.path, to); }

  // ── index and watcher ───────────────────────────────────────────────

  private ensureIndex(): void {
    if (this.indexed) return;
    this.indexed = true;
    const r = bridge().fs.walk();
    if (!r.ok) { console.error(`[compat] vault index unavailable: ${r.error}`); return; }
    for (const e of r.data) this.known.set(e.rel, { ctime: e.ctimeMs, mtime: e.mtimeMs, size: e.size });
  }

  /** Starts emitting vault events from main's watcher; the host calls this once the layout is ready. */
  startWatching(feed?: ChangeFeed): void {
    if (this.unsubscribe) return;
    this.ensureIndex();
    if (!feed) { console.warn("[compat] no vault watcher: the HUD will not see changes made outside it"); return; }
    this.unsubscribe = feed((paths) => {
      for (const p of paths) {
        const rel = normalizePath(p);
        if (!isIgnored(rel)) this.emitFor(rel);
      }
    });
  }

  stopWatching(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private emitFor(rel: string): void {
    const s = this.statOf(rel);
    if (s?.dir) {
      this.trigger("create", new TFolder(this, rel));
      return;
    }
    if (s) {
      const stats = toStats(s);
      const existed = this.known.has(rel);
      this.known.set(rel, stats);
      this.trigger(existed ? "modify" : "create", new TFile(this, rel, stats));
      return;
    }
    if (this.known.delete(rel)) this.trigger("delete", new TFile(this, rel, { ctime: 0, mtime: 0, size: 0 }));
  }
}
