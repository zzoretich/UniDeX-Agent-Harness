// The vault watcher, in the main process: one recursive fs.watch (FSEvents on macOS) whose changed paths are batched
// and handed to the window and the tray. The renderer turns them into Obsidian's create/modify/delete events.

import * as fs from "node:fs";
import * as path from "node:path";
import { isIgnored } from "../../obsidian-compat/src/ignore";

export class VaultWatcher {
  private watcher: fs.FSWatcher | null = null;
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly root: string,
    private readonly onBatch: (paths: string[]) => void,
    private readonly batchMs = 40,
  ) {}

  start(): void {
    if (this.watcher) return;
    this.watcher = fs.watch(this.root, { recursive: true }, (_type, filename) => {
      if (!filename) return;
      const rel = filename.toString().split(path.sep).join("/");
      if (isIgnored(rel)) return;
      // A Set per batch collapses the burst an atomic write produces (temp file, rename) into one path.
      this.pending.add(rel);
      this.timer ??= setTimeout(() => this.flush(), this.batchMs);
    });
    this.watcher.on("error", (err) => console.error("[main] vault watcher error", err));
  }

  private flush(): void {
    this.timer = null;
    const paths = [...this.pending];
    this.pending.clear();
    if (paths.length) this.onBatch(paths);
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }
}
