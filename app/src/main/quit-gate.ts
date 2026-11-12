// The app's quit waits for its terminals (R86). node-pty reports a terminal's exit from a thread of its own through the
// event loop; an exit that lands while Electron tears Node down calls into an environment that can no longer run
// JavaScript, and the app aborts (SIGABRT) instead of exiting 0. Killed only as the window closed on the way out (the
// page's work ends with it), a terminal was usually still running, or ended unreported, when the quit reached will-quit.
//
// So `before-quit` asks the gate first. A quit that finds a terminal running, or one ended whose exit is still to come,
// is held (its default prevented): `settle` ends them all and resolves once each exit has been reported (capped, so a
// stuck child never keeps the app from quitting), and the quit is asked again. That quit finds nothing running and goes
// on. A quit asked while one is held joins it: it is not lost (the held quit goes on, at the cap at the latest) and it
// starts no second wait.

export interface QuitGateOptions {
  /** Whether something must end before the quit goes on (PtyService.busy). */
  busy: () => boolean;
  /** Ends it, resolving once it has, or at its cap (PtyService.settle). */
  settle: () => Promise<void>;
  /** Asks the quit again (app.quit). */
  quit: () => void;
}

export interface QuitGate {
  /** The `before-quit` listener's part: prevents the quit and returns true while it must wait; false lets it go on. */
  hold(e: { preventDefault(): void }): boolean;
  /** Whether a held quit is waiting. */
  readonly holding: boolean;
}

export function quitGate(o: QuitGateOptions): QuitGate {
  let held: Promise<void> | null = null;
  /** The wait, started now; the quit is asked again after it, whatever it did (held is set before that can run). */
  const wait = (): Promise<void> => {
    let ended: Promise<void>;
    try { ended = o.settle(); } catch { ended = Promise.resolve(); }
    return ended.catch(() => undefined).then(() => { held = null; o.quit(); });
  };
  return {
    hold(e) {
      if (!held && !o.busy()) return false;
      e.preventDefault();
      held ??= wait();
      return true;
    },
    get holding() { return held !== null; },
  };
}

/**
 * Whether a quit the app had begun is now known not to be happening. An update's quit runs beforeInstall, then
 * before-quit-for-update, then app.quit() (before-quit); Squirrel reports a failed install after all of those, so the
 * updater's error arrives with `quitting` set, however the quit began. Only that error calls a begun quit
 * off: a quit the gate holds completes, and an error with no quit under way has nothing to cancel.
 */
export function quitCalledOff(f: { quitting: boolean; updateStatus: string }): boolean {
  return f.quitting && f.updateStatus === "error";
}
