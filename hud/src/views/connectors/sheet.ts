// sheet.ts — a Connectors card's detail sheet (spec 2026-10-23-connectors-tab D4, D12, D16, D17, D20): 480 px from the
// right, over the board behind a scrim. One row per host (status, where it comes from, "Copy to <host>" where copyOffers
// gives one, the attention fix, and sideActions' Park and Remove for a user-scope server, Turn on for a parked one, or
// for a plugin's, a connector's or a project's row what to do instead), USAGE over the window (calls, sessions, by host,
// per day), TOOLS as chips with their calls, and where it was found. It only draws; ConnectorsTab owns every action.
import { setIcon } from "obsidian";
import {
  CONN_HOSTS, CONN_HOST_LABEL, STATUS_LABEL, agoWords, attentionFix, foundFiles, kindLine, onBoth, scopeLine, sideActions, sparkHeights, statusTone,
  toolChips,
  type ConnBoard, type ConnCard, type ConnHost, type ConnSide, type CopyOffer, type ManageVerb,
} from "../../data/connectorsModel";

export interface SheetCtx {
  card: ConnCard;
  board: ConnBoard;
  hosts: readonly ConnHost[];
  now: number;
  offers: CopyOffer[];
  /** The target hosts a copy is running for. */
  busy: ReadonlySet<ConnHost>;
  /** The hosts a park, Turn on, remove or add is running for. */
  manageBusy: ReadonlySet<ConnHost>;
  checking: boolean;
  on: {
    close(): void;
    copy(name: string, to: ConnHost): void;
    fix(card: ConnCard): void;
    manage(verb: ManageVerb, name: string, host: ConnHost): void;
  };
}

const VERB_LABEL: Record<ManageVerb, string> = { park: "Park", unpark: "Turn on", remove: "Remove" };
const VERB_TITLE: Record<ManageVerb, (host: string) => string> = {
  park: (h) => `Takes it off ${h} and keeps its exact settings in a private stash outside the vault; shows the exact command first`,
  unpark: (h) => `Puts it back on ${h} as it was; shows the exact command first`,
  remove: (h) => `Takes it out of ${h}'s config for good, its file backed up first; shows the exact command first`,
};

const BARS_PX = 46;

/** The scrim and the sheet, appended to the tab's root. */
export function drawSheet(root: HTMLElement, c: SheetCtx): void {
  const k = c.card;
  const scrim = root.createDiv({ cls: "aos-con-scrim", attr: { "aria-hidden": "true" } });
  scrim.addEventListener("click", () => c.on.close());
  const sheet = root.createEl("aside", {
    cls: "aos-con-sheet",
    attr: { role: "dialog", "aria-modal": "true", "aria-labelledby": "aos-con-sheet-title", "data-tour": "connectors-sheet", "data-conn": k.key },
  });

  const head = sheet.createDiv({ cls: "aos-con-sheethead" });
  const top = head.createDiv({ cls: "aos-con-sheettop" });
  top.createSpan({ cls: `aos-con-dot is-${statusTone(k.status)}`, attr: { role: "img", "aria-label": STATUS_LABEL[k.status], title: STATUS_LABEL[k.status] } });
  top.createEl("h2", { cls: "aos-con-sheettitle", text: k.title, attr: { id: "aos-con-sheet-title" } });
  const close = top.createEl("button", { cls: "aos-con-close", attr: { type: "button", "aria-label": "Close", title: "Close (Esc)", "data-fk": "close" } });
  setIcon(close, "x");
  close.addEventListener("click", () => c.on.close());
  const tags = head.createDiv({ cls: "aos-con-tags" });
  tags.createSpan({ cls: "aos-con-tag", text: kindLine(k) });
  if (onBoth(k) && c.hosts.length === 2) tags.createSpan({ cls: "aos-con-tag is-ok", text: "On both hosts" });
  const what = (k.sides.claude ?? k.sides.codex)?.what;
  if (what) tags.createSpan({ cls: "aos-con-what", text: what, attr: { title: what } });

  const body = sheet.createDiv({ cls: "aos-con-sheetbody" });
  drawHostRows(body, c);
  drawUsage(body, c);
  drawTools(body, c);
  drawFound(body, c);
}

function drawHostRows(body: HTMLElement, c: SheetCtx): void {
  const k = c.card;
  const fix = attentionFix(k);
  const rows = body.createDiv({ cls: "aos-con-hostrows" });
  for (const h of CONN_HOSTS) {
    if (!c.hosts.includes(h)) continue;
    const side = k.sides[h];
    const offer = c.offers.find((o) => o.to === h) ?? null;
    // A connector or a built-in is one host's own: no row for the host it is not on.
    if (!side && k.kind !== "server") continue;
    const row = rows.createDiv({ cls: `aos-con-hostrow${side ? "" : " is-absent"}`, attr: { "data-host": h } });
    const line = row.createDiv({ cls: "aos-con-hostline" });
    line.createSpan({ cls: `aos-con-dot is-${h}${side ? "" : " is-absent"}`, attr: { "aria-hidden": "true" } });
    line.createSpan({ cls: "aos-con-hostname", text: CONN_HOST_LABEL[h] });
    if (side) {
      line.createSpan({ cls: `aos-con-pill is-${statusTone(side.status)}`, text: STATUS_LABEL[side.status] });
      line.createSpan({ cls: "aos-con-scope", text: scopeLine(side), attr: { title: scopeLine(side) } });
    } else {
      line.createSpan({ cls: "aos-con-pill is-off", text: "Not added" });
      line.createSpan({ cls: "aos-con-scope", text: `not in ${CONN_HOST_LABEL[h]}'s config` });
    }
    const acts = line.createSpan({ cls: "aos-con-hostacts" });
    if (side && fix && fix.side.host === h) {
      const busy = fix.fix === "check" && c.checking;
      const b = acts.createEl("button", { cls: "aos-con-btn aos-con-small aos-con-fix", text: busy ? "Checking…" : fix.label, attr: { type: "button", "data-fix": fix.fix, "data-fk": `sheetfix:${h}` } });
      b.disabled = busy;
      b.addEventListener("click", () => c.on.fix(k));
    }
    if (!side && offer) drawCopy(acts, row, offer, k, c);
    const m = side ? sideActions(side) : null;
    if (side && m) {
      for (const verb of m.actions) {
        const busy = c.manageBusy.has(h);
        const b = acts.createEl("button", {
          cls: `aos-con-btn aos-con-small aos-con-manage aos-con-${verb}${verb === "remove" ? " is-danger" : ""}`, text: busy ? "Working…" : VERB_LABEL[verb],
          attr: { type: "button", "data-verb": verb, "data-fk": `${verb}:${h}`, title: VERB_TITLE[verb](CONN_HOST_LABEL[h]), ...(verb === "park" ? { "data-tour": "connectors-park" } : {}) },
        });
        b.disabled = busy;
        b.addEventListener("click", () => c.on.manage(verb, side.name, h));
      }
    }
    if (side?.detail && side.status !== "connected") row.createEl("p", { cls: `aos-con-detail is-${statusTone(side.status)}`, text: side.detail });
    if (m?.hint) row.createEl("p", { cls: "aos-con-detail aos-con-instead", text: m.hint });
  }
}

/** "Copy to <host>" (D20): the source side's name; off with why, and "Working…" while a copy to that host runs. */
function drawCopy(acts: HTMLElement, row: HTMLElement, o: CopyOffer, k: ConnCard, c: SheetCtx): void {
  const from = CONN_HOSTS.find((h) => h !== o.to)!;
  const src = k.sides[from] as ConnSide;
  const busy = c.busy.has(o.to);
  const b = acts.createEl("button", {
    cls: "aos-con-btn aos-con-small aos-con-copy", text: busy ? "Working…" : o.label,
    attr: { type: "button", "data-to": o.to, "data-fk": `copy:${o.to}`, title: o.reason ?? `Shows the exact ${CONN_HOST_LABEL[o.to]} command and the file it writes before anything changes` },
  });
  b.disabled = o.disabled || busy;
  if (!o.disabled) b.addEventListener("click", () => c.on.copy(src.name, o.to));
  if (o.reason) row.createEl("p", { cls: "aos-con-detail", text: o.reason });
}

function drawUsage(body: HTMLElement, c: SheetCtx): void {
  const k = c.card;
  const days = c.board.days;
  const sec = body.createEl("section", { cls: "aos-con-sheetsec aos-con-usage" });
  const h = sec.createEl("h3", { cls: "aos-con-h3" });
  h.createSpan({ text: `USAGE · ${days} DAYS` });
  h.createSpan({ cls: "aos-con-h2note", text: k.calls ? `${k.sessions} session${k.sessions === 1 ? "" : "s"} · last ${agoWords(k.lastUsed, c.now)}` : `no call in ${days} days` });
  const row = sec.createDiv({ cls: "aos-con-usagerow" });
  const big = row.createEl("p", { cls: "aos-con-calls" });
  big.createSpan({ cls: "aos-con-callsn", text: String(k.calls) });
  big.createSpan({ cls: "aos-con-callsw", text: k.calls === 1 ? "call" : "calls" });
  const by = row.createDiv({ cls: "aos-con-byhost" });
  for (const host of CONN_HOSTS) {
    if (!c.hosts.includes(host)) continue;
    const n = k.sides[host]?.usage?.calls ?? 0;
    const line = by.createSpan({ cls: `aos-con-byline${n ? "" : " is-zero"}`, attr: { "data-host": host } });
    line.createSpan({ cls: `aos-con-dot is-${host}`, attr: { "aria-hidden": "true" } });
    line.createSpan({ text: `${CONN_HOST_LABEL[host]} ${n}` });
  }
  const heights = sparkHeights(k.perDay, days, BARS_PX, 4);
  const peak = Math.max(0, ...k.perDay);
  const bars = sec.createDiv({ cls: "aos-con-usagebars", attr: { role: "img", "aria-label": k.calls ? `Calls per day over ${days} days: at most ${peak} in a day` : `No call in ${days} days` } });
  for (const px of heights) {
    const bar = bars.createSpan({ cls: `aos-con-bar${px ? " is-on" : ""}` });
    if (px) bar.style.height = `${px}px`;
  }
}

function drawTools(body: HTMLElement, c: SheetCtx): void {
  const k = c.card;
  const sides = Object.values(k.sides) as ConnSide[];
  const chips = toolChips(k);
  const seen = sides.some((x) => x.toolsSeen);
  const sec = body.createEl("section", { cls: "aos-con-sheetsec aos-con-tools" });
  const h = sec.createEl("h3", { cls: "aos-con-h3" });
  h.createSpan({ text: `TOOLS · ${chips.length}` });
  h.createSpan({ cls: "aos-con-h2note", text: seen ? "seen in use — may be partial" : `calls in ${c.board.days} days` });
  if (!chips.length) {
    const why = sides.map((x) => x.toolsError).find(Boolean);
    sec.createEl("p", { cls: "aos-con-none", text: why ?? (c.board.checkedAt ? "No tools listed: the check could not reach it, and no session has called it." : "Tools show after the first check.") });
    return;
  }
  const list = sec.createDiv({ cls: "aos-con-chips" });
  for (const t of chips) {
    const chip = list.createSpan({ cls: `aos-con-chip${t.calls ? " is-used" : ""}`, attr: { "data-tool": t.name, ...(t.summary ? { title: t.summary } : {}) } });
    chip.createSpan({ text: t.name });
    if (t.calls) chip.createSpan({ cls: "aos-con-chipn", text: String(t.calls) });
  }
}

function drawFound(body: HTMLElement, c: SheetCtx): void {
  const k = c.card;
  const p = body.createEl("p", { cls: "aos-con-found" });
  const checked = c.board.checkedAt ? ` Checked ${agoWords(c.board.checkedAt, c.now)}.` : " Not checked yet.";
  if (k.kind === "builtin") {
    const host = (Object.values(k.sides) as ConnSide[]).map((x) => CONN_HOST_LABEL[x.host]).join(" and ");
    p.setText(`Seen in use in ${host}'s sessions; no config file declares it.`);
    return;
  }
  const files = foundFiles(k);
  if (!files.length) {
    p.setText(`Listed by ${k.sides.claude ? "your claude.ai account" : "Codex's ChatGPT apps"}.${checked}`);
    return;
  }
  p.appendText("Found automatically in ");
  files.forEach((f, i) => {
    if (i) p.appendText(i === files.length - 1 ? " and " : ", ");
    p.createSpan({ cls: "aos-con-mono-text", text: f });
  });
  p.appendText(`.${checked}`);
}
