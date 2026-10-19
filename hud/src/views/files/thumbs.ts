// Thumbnails in Icons (files-finder D19): an image's tile shows the picture instead of its page. png, jpg, gif, webp
// and svg up to 4 MB (filesModel thumbable) are read only once their tile comes into view, one per animation frame
// (readBinary is synchronous per chunk, so a folder of photos never stalls the page), and kept by path and
// modification time, THUMB_CACHE_MAX at most. A picture larger than the tile is drawn down to it, so the cache holds
// small images rather than whole photos; an SVG keeps its own bytes. What cannot be read or drawn keeps its page.

import { Lru, THUMB_CACHE_MAX, thumbable, type Item } from "../../data/filesModel";
import { imageMime } from "./Preview";

export interface ThumbDeps {
  /** The file's bytes (the vault adapter's readBinary). */
  read(path: string): Promise<ArrayBuffer>;
  /** Bytes as a data: URL of the image type `ext` names (Preview.ts toDataUrl; the CSP's img-src allows data:). */
  toDataUrl(bytes: ArrayBuffer, ext: string): string | null;
}

/** The longest side a picture is drawn down to: twice the tile's art, for a Retina screen. */
const THUMB_PX = 168;

export class Thumbs {
  /** By path: the modification time it was read at, and its data: URL (null: it could not be read or drawn). */
  private cache = new Lru<{ mtime: number | null; url: string | null }>(THUMB_CACHE_MAX);
  private io: IntersectionObserver | null = null;
  private root: HTMLElement | null = null;
  private waiting = new Map<Element, Item>();
  private queue: Array<{ art: HTMLElement; item: Item }> = [];
  private frame: number | null = null;
  private busy = false;

  constructor(private deps: ThumbDeps) {}

  /** A new draw of the view inside `root` (null: the tab is put away). The last draw's tiles are gone, and with them
   *  what was waiting; a read under way still lands in the cache. */
  reset(root: HTMLElement | null): void {
    this.io?.disconnect();
    this.io = null;
    this.root = root;
    this.waiting.clear();
    this.queue = [];
    if (!root && this.frame !== null) { window.cancelAnimationFrame(this.frame); this.frame = null; }
  }

  /** Gives `art` (a tile's art, showing its page) the picture of `item`: at once when it is cached, otherwise once the
   *  tile comes into view. Anything thumbable() refuses keeps its page. */
  show(art: HTMLElement, item: Item): void {
    if (!thumbable(item)) return;
    const hit = this.cache.get(item.path);
    if (hit && hit.mtime === item.mtime) { if (hit.url) place(art, hit.url); return; }
    if (typeof IntersectionObserver === "undefined") { this.enqueue(art, item); return; }
    if (!this.io) this.io = new IntersectionObserver((entries) => this.seen(entries), { root: this.root, rootMargin: "160px 0px" });
    this.waiting.set(art, item);
    this.io.observe(art);
  }

  private seen(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const item = this.waiting.get(e.target);
      this.io?.unobserve(e.target);
      this.waiting.delete(e.target);
      if (item) this.enqueue(e.target as HTMLElement, item);
    }
  }

  private enqueue(art: HTMLElement, item: Item): void {
    this.queue.push({ art, item });
    this.pump();
  }

  /** One read per frame, each after the one before it has landed. */
  private pump(): void {
    if (this.frame !== null || this.busy || !this.queue.length) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = null;
      const next = this.queue.shift();
      if (!next) return;
      this.busy = true;
      void this.load(next.art, next.item).finally(() => { this.busy = false; this.pump(); });
    });
  }

  private async load(art: HTMLElement, item: Item): Promise<void> {
    // Scrolled past and drawn again since: the new tile asks for itself.
    if (!art.isConnected) return;
    const hit = this.cache.get(item.path);
    let url = hit && hit.mtime === item.mtime ? hit.url : undefined;
    if (url === undefined) {
      try {
        const bytes = await this.deps.read(item.path);
        url = item.ext === "svg" ? this.deps.toDataUrl(bytes, "svg") : await shrink(bytes, item.ext, this.deps.toDataUrl);
      } catch {
        url = null;
      }
      this.cache.set(item.path, { mtime: item.mtime, url });
    }
    if (url && art.isConnected) place(art, url);
  }
}

/** A raster image as a data: URL no larger than the tile needs: drawn down when it is bigger, its own bytes when not
 *  (a small GIF keeps moving). Null when it does not decode. */
async function shrink(bytes: ArrayBuffer, ext: string, toDataUrl: ThumbDeps["toDataUrl"]): Promise<string | null> {
  const mime = imageMime(ext);
  if (!mime) return null;
  if (typeof createImageBitmap !== "function") return toDataUrl(bytes, ext);
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(new Blob([bytes], { type: mime })); } catch { return null; }
  try {
    const scale = Math.min(1, THUMB_PX / Math.max(bmp.width, bmp.height, 1));
    if (scale === 1) return toDataUrl(bytes, ext);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const g = canvas.getContext("2d");
    if (!g) return toDataUrl(bytes, ext);
    g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/webp", 0.85);
  } finally {
    bmp.close();
  }
}

/** Puts the picture in the tile's art; the page goes once it has loaded, and stays if it does not. */
function place(art: HTMLElement, url: string): void {
  if (art.querySelector(".aos-fx-thumb")) return;
  const img = document.createElement("img");
  img.className = "aos-fx-thumb";
  img.alt = "";
  // The tile drags (D15), not the picture in it.
  img.draggable = false;
  img.decoding = "async";
  img.addEventListener("load", () => {
    art.querySelector(".aos-fx-art-page")?.remove();
    art.addClass("has-thumb");
  }, { once: true });
  img.addEventListener("error", () => img.remove(), { once: true });
  img.src = url;
  art.appendChild(img);
}
