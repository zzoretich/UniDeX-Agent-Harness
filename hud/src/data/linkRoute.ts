// Where a web link clicked in the app goes (session-browser S14): a link clicked inside a session opens in that session's
// own browser; outside a session, or with the Computer surface off, nothing changes from before: https goes to the
// default browser and http opens nowhere, with a notice saying why.
import type { HostComputer } from "../host";

export const HTTP_NOTICE = "This link is http, not https, so it opens only in a session's browser.";
export const REFUSED_NOTICE = "This link was not opened: its address holds a user name or password, or is too long.";
export const LINK_FAILED = "The link did not open in this session's browser.";

export type LinkRoute = { to: "session"; session: string; url: string } | { to: "outside"; url: string } | { to: "notice"; text: string };

/** null: not an http or https address (the caller does what it did: agenticos: links, vault paths). */
export function linkRoute(url: URL, session: string | null, computerOn: boolean): LinkRoute | null {
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (session && computerOn) return { to: "session", session, url: url.toString() };
  return outside(url.protocol, url.toString());
}

function outside(protocol: string, url: string): LinkRoute {
  return protocol === "https:" ? { to: "outside", url } : { to: "notice", text: HTTP_NOTICE };
}

/** Which session a Code chat click belongs to: the active terminal's for the live chat; none for a past conversation's
 *  chat, which has no browser (session-browser S1) even while a terminal is active behind it. */
export function sessionForLink(view: "live" | "past", active: string | null): string | null {
  return view === "past" ? null : active;
}

export async function followLink(
  route: LinkRoute,
  host: { computer?: HostComputer; openExternal(url: string): Promise<void>; notice(text: string): void },
): Promise<void> {
  if (route.to === "notice") { host.notice(route.text); return; }
  if (route.to === "outside") { await host.openExternal(route.url); return; }
  if (host.computer) {
    let res: { ok: boolean; code?: string } | null = null;
    try { res = await host.computer.openLink(route.session, route.url); } catch { res = null; }
    if (res?.ok) return;
    if (res?.code === "EINVAL") { host.notice(REFUSED_NOTICE); return; }
    // EPERM: no session browser to use (not a session the app holds, or the Computer surface is off): as a link outside.
    // Anything else: the browser was there and the link did not open; say so and open nothing anywhere else.
    if (res?.code !== "EPERM") { host.notice(LINK_FAILED); return; }
  }
  const fallback = outside(new URL(route.url).protocol, route.url);
  if (fallback.to === "notice") host.notice(fallback.text); else await host.openExternal(route.url);
}
