// computerStart.ts — the Computer pane's start page and search: DuckDuckGo. A tab the person opens (the pane's +) starts
// on the start page, and words typed in the address bar search it; a tab an agent opens loads its own URL. Pure and
// import-free: main imports it too (index.ts and computer/service.ts), so the app and the HUD share this one copy. The
// e2e suite points both at its local fixture (AOS_E2E_START_PAGE, computer/notify.ts testSwitches), and main hands the
// HUD the start page it uses (HostComputer.startPage).

/** Where a tab the person opens starts. */
export const START_PAGE = "https://duckduckgo.com/";

/** The search for `words` on a start page: the page, `?q=` and the words URL-encoded (encodeURIComponent). */
export function searchUrl(words: string, start: string = START_PAGE): string {
  return `${start}?q=${encodeURIComponent(words)}`;
}
