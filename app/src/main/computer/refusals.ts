// Every sentence an agent can be refused or told an error with (session-browser S16, Task 19), in one table so each can be
// read, reworded and tested in one place: the computer service's, the gate's, the browser's and the DevTools helpers' errors,
// and the bridge's replies. Each is one sentence in the form `<what happened>: <what to do next>.`, with the `computer_*`
// tool named where the next step is a call. An entry that needs one inserted value is a function of one string. Where the
// page is worth naming, the service adds the page line after the sentence; the entries are the sentences alone. No Electron.
//
// Not here: the reason fragments the service puts in its log lines and card endings, the lines and notes written for the
// PERSON (the activity log keeps its own wording: `Told.person` in cdp.ts), the page calls' error codes, and the texts of the
// door and the opener.

export const REFUSAL = {
  // The browser is off, or leaving (session-browser S3, S5).
  off: "The Computer pane is off: ask the user to turn it on in Settings › Computer.",
  declined: "The user declined to turn the browser on: go on without the browser.",
  isOff: "The browser is off: call computer_open, which asks the user to turn it on.",
  offReadOnly: "The browser is off and this session is read only: ask the user to turn the browser on.",
  switchedOff: "The user switched the browser off: go on without the browser.",
  quitting: "The app is quitting: try again when it is back.",
  tabClosed: "The user closed the tab: call computer_status to see what is open.",

  // The wheel and the lease (agent-computer D31, D34, R78, R80, R81).
  changed: "The page changed while you waited: look again.",
  /** D34 (R78): the call's 45 s ran out before it took the computer. R80: the action did not run, though a read already
   *  under way (a ref scrolled into view, the pointer moved) may have. The `busy:` opening is matched by older runtimes. */
  late: "busy: this call waited its 45 s for the computer and the action did not run: call it again.",
  moved: "The page or tab changed while the focus was read: look again.",
  restarted: "The session restarted: call computer_status and carry on.",
  /** Someone else drives (the wheel's reason) or this session no longer holds the wheel. */
  busy: (why: string) => `busy: ${why}: call computer_status to see who has the wheel, then try again.`,
  busyUser: (why: string) => `busy: ${why}: wait for Hand back.`,

  // The arguments of a call.
  badRef: "Bad ref: give a snapshot ref, such as e12.",
  badTab: "Bad tab: give a tab index, such as 0.",
  noUrl: "No url: give the page to open.",
  noTarget: "Nothing to click: give either ref, or both x and y.",
  noText: "Nothing to type: give text, at most 20,000 characters.",
  noKey: "No key: give key, such as Enter or Shift+Tab.",
  noDistance: "No distance: give dy in pixels (and dx if needed).",
  unknownTool: "Unknown tool: use one of the computer_* tools.",
  /** computer_console is named so the bridge counts thirteen tools; its reads come with the console task (Task 21). */
  consoleSoon: "The console is not available yet: use computer_snapshot to read the page.",
  badAskId: "Bad askId: give the id from a waiting_for_user reply.",
  badWaitText: "Bad text: give 1 to 200 characters.",
  badClose: "Bad close: give true or false.",
  badGo: "Bad go: give back, forward or reload.",
  badDouble: "Bad double: give true or false.",
  noHover: "Nothing to hover: give either ref, or both x and y.",

  // While acting.
  clickMovedFocus: "The click moved the focus somewhere that asks first: call computer_type again without ref.",
  typingStopped: (why: string) => `Typing stopped part way because ${why}: call computer_snapshot to see what was typed.`,

  // The person's answer to an ask (the ask broker's outcomes).
  denied: (what: string) => `The user denied it (${what}): go on without it unless the user asks for it.`,
  timedOut: (what: string) => `The user did not answer in time, so it was denied (${what}): go on without it, or try once more if the task cannot go on.`,
  cancelled: (why: string) => `Cancelled because ${why}: call computer_status before you try it again.`,
  askDenied: "The user denied it: go on without it unless the user asks for it.",
  askDeniedBecause: (reason: string) => `Denied because ${reason}: call computer_status before you try it again.`,
  noSuchAsk: (id: string) => `There is no ask "${id}": call computer_snapshot to see whether the action already ran.`,
  otherSessionsAsk: "That ask belongs to another session: wait only on an askId this session was given.",

  // The gate's verdicts (gate.ts).
  readOnly: "This session is read only, so it can look but not act: ask the user for more access if the task needs it.",
  notWeb: "Only http and https pages open: give an address that starts with http:// or https://.",
  passwordField: "Typing into a password field is refused: ask the user to type it themselves.",
  otherSiteFrame: "Typing into a frame from another site is refused: ask the user to type it themselves.",
  unknownAction: "Unknown action: use one of the computer_* tools.",

  // The browser's own errors (browser.ts, cdp.ts), which reach the agent as the reply of the call that met them.
  pageChanged: "The page changed: look again.",
  focusMoved: "The focus moved: look again.",
  pageSlow: (what: string) => `The page did not answer in time (${what}): call computer_snapshot to see where it stands, then try again.`,
  emptyKeyPart: (key: string) => `"${key}" is not a key: a part is empty, so give parts joined by +, such as Shift+Tab.`,
  notModifier: (part: string) => `"${part}" is not a modifier: only Shift, Control, Alt and Meta go before the last part, as in Shift+Tab.`,
  unknownKey: (key: string) => `"${key}" is not a key this browser knows: use a name such as Enter, Tab or ArrowDown.`,
  redirectRefused: (what: string) => `The page redirected to ${what} URL, which this browser refuses: open another page, or ask the user to finish this one in their own browser.`,
  couldNotOpen: (what: string) => `Could not open ${what}: check the address, then try again or open another page.`,
  noRefNow: (ref: string) => `There is no ${ref} on this page now: take a new snapshot.`,
  covered: "Something else covers that element now: take a new snapshot.",
  noPage: "No page is open: call computer_open first.",
  noTab: (index: string) => `There is no tab ${index}: call computer_status to see the tabs.`,
  browserGone: "The browser is gone: call computer_status to see whether it is back.",
  tooManyTabs: (max: string) => `${max} tabs are open: close one first.`,
  otherDebugger: "Another debugger is attached to this tab, so it cannot be driven: ask the user to close DevTools or the other debugger on that tab.",
  devToolsOpen: "DevTools is open on this tab, so it cannot be driven: ask the user to close it.",
  /** Back or Forward with no entry to go to (session-browser S17); `go` is "back" or "forward". */
  noHistory: (go: string) => `There is no page to go ${go} to: call computer_status to see the tabs, or open a page with computer_open.`,
  tabGone: "That tab was closed: call computer_status to see what is open.",
  sizeChanged: "The page changed size while the screenshot was taken, so it was not returned: try again.",
  notVisible: "That element is not visible on the page: take a new snapshot.",
  passwordUnread: "Could not read a password field's value to scrub it, so the text was held back: try again.",
  nothingThere: "There is nothing at that point on the page: take a new snapshot or give another x and y.",
  cantTell: "Cannot tell which control this click reaches: take a new snapshot.",

  // The bridge's own replies (bridge.ts).
  tooMany: "Too many computer calls at once: wait for one to finish.",
  alreadyOpen: "This session's computer connection is already open: use that connection, or end the other one first.",
  notStarted: "Not started by UniDeX: start this session from the Code page's New menu or a Chat thread.",
  ended: "This session has ended, so its computer connection is closed: start a new session to use the browser.",
  computerFailed: (why: string) => `The computer failed (${why}): call computer_status to see whether the browser is still there.`,
} as const satisfies Readonly<Record<string, string | ((x: string) => string)>>;
