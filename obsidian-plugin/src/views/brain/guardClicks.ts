// One click, one action, for the Brain hub's row buttons (Health's Not duplicates, Bootstrap's Unpin and Mark complete):
// a row can leave while the pointer rests on it, and the next row's same button then sits under the second click.
/**
 * A row action's click: the second (and third) click of a double-click is not a new action (the row it was on may have
 * gone, and the next row's same button taken its place), nor is a held Enter or Space's repeat. A keyboard press
 * activates with detail 0, so it still works once per press.
 */
export function guardClicks(b: HTMLElement, run: () => void): void {
  b.addEventListener("click", (e: MouseEvent) => { if (e.detail > 1) return; run(); });
  b.addEventListener("keydown", (e: KeyboardEvent) => { if (e.repeat && (e.key === "Enter" || e.key === " ")) e.preventDefault(); });
}
