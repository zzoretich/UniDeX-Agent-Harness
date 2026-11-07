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

/** The origin a page belongs to (the unit a person marks as trusted), or null for about:blank and anything else. */
export function siteOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}
