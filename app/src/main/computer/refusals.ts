// Every sentence the computer service refuses an agent with (session-browser S8, Task 19), in one table so each can be read,
// reworded and tested in one place. Each is one sentence in the form `<what happened>: <what to do next>.`, with the
// `computer_*` tool named where the next step is a call. An entry that needs one inserted value is a function of one string
// (a reason the gate, the wheel or the ask broker gave). Where the page is worth naming, the service adds the page line
// after the sentence; the entries are the sentences alone. No Electron: the gate imports it too.
//
// Not here: the reason fragments the service puts in its log lines and card endings, the page calls' error codes, and the
// texts another module words (the browser's and the snapshot's errors, the door's and the opener's).

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
  badAskId: "Bad askId: give the id from a waiting_for_user reply.",
  badWaitText: "Bad text: give 1 to 200 characters.",

  // While acting.
  clickMovedFocus: "The click moved the focus somewhere that asks first: call computer_type again without ref.",
  typingStopped: (why: string) => `Typing stopped part way because ${why}: call computer_snapshot to see what was typed.`,

  // The person's answer to an ask (the ask broker's outcomes).
  denied: (what: string) => `The user denied it (${what}): go on without it, or ask again if you still need it.`,
  timedOut: (what: string) => `The user did not answer in time, so it was denied (${what}): ask again if you still need it.`,
  cancelled: (why: string) => `Cancelled because ${why}: ask again if you still need it.`,
  askDenied: "The user denied it: go on without it, or ask again if you still need it.",
  askDeniedBecause: (reason: string) => `Denied because ${reason}: ask again if you still need it.`,
  noSuchAsk: (id: string) => `There is no ask "${id}": call the action again to ask afresh.`,
  otherSessionsAsk: "That ask belongs to another session: wait only on an askId this session was given.",

  // The gate's verdicts (gate.ts).
  readOnly: "This session is read only: ask the user to give it more access.",
  notWeb: "Only http and https pages open: give an address that starts with http:// or https://.",
  passwordField: "Typing into a password field is refused: ask the user to type it themselves.",
  otherSiteFrame: "Typing into a frame from another site is refused: ask the user to type it themselves.",
  unknownAction: "Unknown action: use one of the computer_* tools.",
} as const satisfies Readonly<Record<string, string | ((x: string) => string)>>;
