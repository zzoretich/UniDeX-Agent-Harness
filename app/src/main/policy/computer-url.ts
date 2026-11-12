// Which URLs a Computer view may navigate to (agent-computer D39, §4.2). Only http and https pages open, plus an
// empty about:blank: never javascript:, data:, blob:, file:, a custom app scheme, a browser-internal page or any other
// about: page, all of which would run code or reach the local machine. A string that does not parse is refused.

/** Whether the Computer view may navigate to `url`. */
export function navAllowed(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === "about:") return u.href === "about:blank" || u.href.startsWith("about:blank#");
  return u.protocol === "http:" || u.protocol === "https:";
}

/** A web address the person clicked (session-browser S14), as the browser opens it: http or https, at most 8,192 characters, and
 *  no user name or password (refused, not cleaned). `0.0.0.0` and `[::]`, which a server prints but a browser cannot reach, become
 *  `localhost`. Anything else is null. */
export function linkUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 8192) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (u.hostname === "0.0.0.0" || u.hostname === "[::]") u.hostname = "localhost";
  return u.toString();
}

/** The origin a page belongs to (the unit a person marks as trusted), or null for about:blank and anything else. */
export function siteOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** `url` without a user name or password (session-browser S6: an address that leaves main or is stored never carries
 *  credentials). An address with none, or one that does not parse, comes back unchanged. */
export function withoutUserinfo(url: string): string {
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return url;
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return url;
  }
}
