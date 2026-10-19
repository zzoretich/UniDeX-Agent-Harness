// Obsidian's file objects and normalizePath. Built from fs.stat on demand; the HUD only reads path, name, basename,
// extension and stat, and checks `instanceof TFile`.

import type { Vault } from "./vault";

export function normalizePath(p: string): string {
  let s = String(p ?? "").replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
  s = s.normalize("NFC");
  return s === "" ? "/" : s;
}

export interface FileStats { ctime: number; mtime: number; size: number }

export abstract class TAbstractFile {
  vault: Vault;
  path: string;
  name: string;
  parent: TFolder | null = null;

  constructor(vault: Vault, path: string) {
    this.vault = vault;
    this.path = path;
    this.name = path === "/" ? "" : path.split("/").pop() ?? path;
  }
}

export class TFile extends TAbstractFile {
  stat: FileStats;
  basename: string;
  extension: string;

  constructor(vault: Vault, path: string, stat: FileStats) {
    super(vault, path);
    this.stat = stat;
    const dot = this.name.lastIndexOf(".");
    this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
    this.extension = dot > 0 ? this.name.slice(dot + 1) : "";
  }
}

export class TFolder extends TAbstractFile {
  get children(): TAbstractFile[] { return this.vault.listChildren(this.path); }
  isRoot(): boolean { return this.path === "/"; }
}
