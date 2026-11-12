// The one place a clicked web link meets the app (session-browser S14): the route from data/linkRoute, followed with the
// real host. Returns false for an address that is not http or https, so the caller does what it did for it.
import { Notice } from "obsidian";
import { hudHost, shell } from "../host";
import { followLink, linkRoute } from "../data/linkRoute";

export function openWebLink(url: URL, session: string | null): boolean {
  const computer = hudHost().computer;
  const route = linkRoute(url, session, computer?.enabled === true);
  if (!route) return false;
  void followLink(route, { computer, openExternal: (u) => shell.openExternal(u), notice: (t) => { new Notice(t); } });
  return true;
}

const routed = new WeakSet<object>();

/** Routes the web links clicked inside `container` (session-browser S14). One CAPTURE-phase listener: it runs before
 *  the markdown renderer's own link listener and, when it routes a link, stops the click there, so the link opens once.
 *  `follow` is openWebLink; tests pass a fake. */
export function routeWebLinks(
  container: HTMLElement,
  session: () => string | null,
  follow: (url: URL, session: string | null) => boolean = openWebLink,
): void {
  if (routed.has(container)) return;
  routed.add(container);
  container.addEventListener("click", (e) => {
    const t = e.target as { closest?: (sel: string) => Element | null } | null;
    const a = t?.closest?.("a[href]");
    if (!a) return;
    let u: URL;
    try { u = new URL(a.getAttribute("href") ?? ""); } catch { return; }
    if (!follow(u, session())) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}
