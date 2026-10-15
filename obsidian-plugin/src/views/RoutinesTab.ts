import { Notice } from "obsidian";
import type { TAbstractFile } from "obsidian";
import * as path from "path";
import type AgenticOSPlugin from "../../main";
import type { WorkbenchView } from "./WorkbenchView";
import { ConfirmModal } from "../ui/ConfirmModal";
import { readAgenticosJson, readVaultConfig, sessionHosts } from "../data/aosConfig";
import { describe, next as nextFire, validateCron } from "../data/cron";
import {
  Routine, RoutineRow, RoutinesState, RoutineKind, KINDS, EFFORTS, ROUTINES_DIR, ROUTINES_STATE_PATH, SLUG_RE, DUTY_LOG_DIR, DutyLogRun,
  listRoutines, readRoutinesState, buildRows, schedulesOutOfDate, emptyState, readDutyLogLast,
} from "../data/routines";
import { adapterOf, writeRoutine, setRoutineEnabled, deleteRoutine, isGuardedChange, GuardedRoutineError, RoutineDraft } from "../data/routineWriter";
import { readExternalSchedules, ExternalSchedule } from "../data/externalSchedules";
import { readHostRoutines, hostRows, hostChip, codexRefreshDue, emptyHostRoutines, HostRoutinesCache, HOST_ROUTINES_PATH, HOST_NAMES } from "../data/hostRoutines";

const RUNNER = "brain/scripts/routines/run-routine.js";
const AOS_CLI = "brain/scripts/cli/aos.js";
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number) => String(n).padStart(2, "0");
export function formatFire(d: Date): string {
  return `${DAY[d.getDay()]} ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function formatAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "?";
  if (ms < 90_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 36 * 3_600_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

/**
 * ROUTINES — one row per brain/routines/<slug>.md with cadence, next fire, last run and a health chip;
 * a drawer form to create or edit; run-now / on-off / apply-schedules that spawn the runtime (never
 * launchctl directly — spec D8); and the read-only "Outside the runtime" rows: launchd labels and the
 * Obsidian Git timer (D13) plus the routines each session host owns from brain/_index/routines-hosts.json
 * (host-routines D4 — written by the runtime, refreshed here by spawning `aos routines hosts --refresh`).
 * Logic lives in src/data/{routines,routineWriter,externalSchedules,hostRoutines,cron}.ts; this class only
 * renders and wires.
 */
export class RoutinesTab {
  private host: HTMLElement | null = null;
  private routines: Routine[] = [];
  private state: RoutinesState = emptyState();
  private rows: RoutineRow[] = [];
  private external: ExternalSchedule[] = [];
  private hosts: HostRoutinesCache = emptyHostRoutines();
  private dutyLogs: Record<string, DutyLogRun | null> = {};
  private hostRefreshAt = 0;
  private listenersRegistered = false;
  private refreshDebounce: number | null = null;
  private tick: number | null = null;

  constructor(private plugin: AgenticOSPlugin, private view: WorkbenchView) {}

  mount(host: HTMLElement): void {
    this.host = host;
    if (!this.listenersRegistered) {
      this.listenersRegistered = true;
      const watch = (f: TAbstractFile) => { if (f.path.startsWith(ROUTINES_DIR + "/") || f.path === ROUTINES_STATE_PATH || f.path === HOST_ROUTINES_PATH || f.path.startsWith(DUTY_LOG_DIR + "/duty-")) this.schedule(); };
      this.view.registerEvent(this.plugin.app.vault.on("modify", watch));
      this.view.registerEvent(this.plugin.app.vault.on("create", watch));
      this.view.registerEvent(this.plugin.app.vault.on("delete", watch));
    }
    if (this.tick === null) this.tick = window.setInterval(() => { if (this.view.isTabActive("routines")) this.render(); }, 60_000);
    void this.refresh();
  }

  unmount(): void {
    if (this.tick !== null) { window.clearInterval(this.tick); this.tick = null; }
    if (this.refreshDebounce !== null) { window.clearTimeout(this.refreshDebounce); this.refreshDebounce = null; }
  }

  private schedule(): void {
    if (this.refreshDebounce !== null) window.clearTimeout(this.refreshDebounce);
    this.refreshDebounce = window.setTimeout(() => void this.refresh(), 250);
  }

  async refresh(): Promise<void> {
    const root = this.plugin.vaultRoot();
    this.routines = await listRoutines(this.plugin.app);
    this.state = await readRoutinesState(this.plugin.app);
    const cfg = readVaultConfig(root, this.plugin.claudeConfigDir());
    this.external = readExternalSchedules(root, cfg.routines.externalLabels);
    this.hosts = readHostRoutines(root);
    this.dutyLogs = {};
    for (const r of this.routines) if (r.kind === "duty") this.dutyLogs[r.slug] = readDutyLogLast(root, r.slug);
    // The Codex section is live data the runtime reads through sqlite3: ask for it when it is old (at most once a minute),
    // and only where Codex is a host. Without Codex the section never appears, so it would be asked for every minute.
    const hosts = sessionHosts(readAgenticosJson(this.plugin.claudeConfigDir()));
    if (codexRefreshDue(hosts, this.hosts.hosts.codex, this.hostRefreshAt)) this.refreshHosts();
    this.render();
  }

  /** `aos routines hosts --refresh`: re-reads the Codex Automations and rewrites the cache; the file event re-renders. */
  private refreshHosts(): void {
    this.hostRefreshAt = Date.now();
    this.plugin.runBrainScript(AOS_CLI, ["routines", "hosts", "--refresh"], () => this.schedule(), { env: this.spawnEnv() });
  }

  // ── render ──

  private render(): void {
    if (!this.view.isTabActive("routines")) return;
    const host = this.host;
    if (!host) return;
    host.empty();
    const now = new Date();
    this.rows = buildRows(this.routines, this.state, now, this.dutyLogs);

    const head = host.createDiv({ cls: "aos-rt-head" });
    head.createSpan({ cls: "aos-rt-title", text: "Routines" });
    head.createSpan({ cls: "aos-dim aos-rt-count", text: `${this.rows.filter((r) => r.routine.enabled).length} on · ${this.rows.length} total` });
    const actions = head.createDiv({ cls: "aos-rt-actions" });
    const newBtn = actions.createEl("button", { cls: "aos-ws-action", text: "+ new", attr: { "data-tour": "routines-new" } });
    newBtn.addEventListener("click", () => this.openEditor(null));
    const applyBtn = actions.createEl("button", { cls: "aos-ws-action", text: "apply schedules", attr: { "data-tour": "routines-apply" } });
    applyBtn.addEventListener("click", () => this.applySchedules());

    const outOfDate = schedulesOutOfDate(this.routines, this.state);
    if (outOfDate.length) {
      const banner = host.createDiv({ cls: "aos-rt-banner" });
      banner.createSpan({ text: `schedules out of date (${outOfDate.join(", ")}) — ` });
      const link = banner.createEl("a", { text: "apply now", cls: "aos-link", href: "#" });
      link.addEventListener("click", (e) => { e.preventDefault(); this.applySchedules(); });
    }

    const table = host.createDiv({ cls: "aos-inv-table aos-rt-table", attr: { "data-tour": "routines-list" } });
    if (!this.rows.length) {
      table.createDiv({ cls: "aos-inv-row aos-dim", text: `no routines yet — "+ new" writes ${ROUTINES_DIR}/<slug>.md` });
    }
    for (const row of this.rows) this.renderRow(table, row, now);

    const hostList = hostRows(this.hosts);
    const sections = HOST_NAMES.filter((h) => this.hosts.hosts[h]);
    if (this.external.length || hostList.length || sections.length) {
      const sub = host.createDiv({ cls: "aos-rt-subhead aos-dim", attr: { "data-tour": "routines-outside" } });
      sub.createSpan({ text: "OUTSIDE THE RUNTIME" });
      // Snapshot ages per host and the refresh link (Codex re-reads live; the Claude section needs `/routines cloud`).
      const trail = sub.createSpan({ cls: "aos-rt-asof" });
      trail.createSpan({ text: sections.map((h) => `${h} as of ${formatAgo(this.hosts.hosts[h]!.fetchedAt, now.getTime())}`).join(" · ") });
      const link = trail.createEl("a", { text: "refresh", cls: "aos-link", href: "#", attr: { title: "aos routines hosts --refresh (Codex live; the Claude Code snapshot updates with /routines cloud in a session)" } });
      link.addEventListener("click", (e) => { e.preventDefault(); this.refreshHosts(); });
      const ext = host.createDiv({ cls: "aos-inv-table aos-rt-table" });
      for (const e of this.external) {
        const r = ext.createDiv({ cls: "aos-inv-row aos-rt-row", attr: { title: e.source } });
        r.createSpan({ cls: "aos-rt-name", text: e.name });
        r.createSpan({ cls: "aos-pill aos-pill-dim", text: e.id === "obsidian-git" ? "obsidian" : "launchd" });
        r.createSpan({ cls: "aos-rt-cadence", text: e.cadence });
        r.createSpan({ cls: "aos-rt-next aos-dim", text: "—" });
        r.createSpan({ cls: "aos-rt-last aos-dim", text: "" });
        r.createSpan({ cls: `aos-pulse-chip ${e.loaded === false ? "is-stale" : "is-neutral"}`, text: e.loaded === false ? "not loaded" : "read-only" });
      }
      for (const h of hostList) {
        const tip = [h.summary, h.target ? `target: ${h.target}` : "", h.model ? `model: ${h.model}` : "", h.schedule ? `schedule: ${h.schedule}` : ""].filter(Boolean).join("\n");
        const r = ext.createDiv({ cls: `aos-inv-row aos-rt-row${h.enabled ? "" : " is-off"}`, attr: { title: tip } });
        const name = r.createDiv({ cls: "aos-rt-name" });
        if (h.link) name.createEl("a", { text: h.name, href: h.link, cls: "aos-link", attr: { target: "_blank", rel: "noopener" } });
        else name.createDiv({ text: h.name });
        r.createSpan({ cls: `aos-pill ${h.host === "claude" ? "aos-pill-cyan" : "aos-pill-amber"}`, text: h.host });
        r.createSpan({ cls: "aos-rt-cadence", text: h.cadence, attr: { title: h.schedule } });
        r.createSpan({ cls: "aos-rt-next aos-dim", text: h.next ? formatFire(new Date(h.next)) : "—" });
        r.createSpan({ cls: "aos-rt-last aos-dim", text: h.last ? `${formatAgo(h.last.at, now.getTime())} · ${h.last.status}` : "never" });
        const chip = hostChip(h);
        r.createSpan({ cls: `aos-pulse-chip ${chip.cls}`, text: chip.text });
      }
      for (const h of sections) {
        const s = this.hosts.hosts[h]!;
        if (s.ok === false && s.warning) ext.createDiv({ cls: "aos-inv-row aos-dim", text: `${h}: ${s.warning}` });
        else if (!s.routines.length) ext.createDiv({ cls: "aos-inv-row aos-dim", text: `${h}: no routines` });
      }
    }
  }

  private renderRow(table: HTMLElement, row: RoutineRow, now: Date): void {
    const r = row.routine;
    const el = table.createDiv({ cls: `aos-inv-row aos-rt-row${r.enabled ? "" : " is-off"}` });
    const name = el.createDiv({ cls: "aos-rt-name" });
    name.createDiv({ text: r.name ?? r.slug });
    name.createDiv({ cls: "aos-dim aos-rt-slug", text: r.slug + (r.guarded ? " · guarded" : "") });
    el.createSpan({ cls: "aos-pill aos-pill-dim", text: String(r.kind ?? "?") });
    el.createSpan({ cls: "aos-rt-cadence", text: row.cadence, attr: { title: r.schedule ?? "" } });
    el.createSpan({ cls: "aos-rt-next aos-dim", text: row.next[0] ? formatFire(row.next[0]) : "—", attr: { title: row.next.map(formatFire).join("\n") } });
    const last = row.last;
    el.createSpan({
      cls: "aos-rt-last aos-dim",
      text: last ? `${formatAgo(last.lastRunAt, now.getTime())} · exit ${last.lastExit}${last.lastCostUsd != null ? ` · $${Number(last.lastCostUsd).toFixed(2)}` : ""}` : "never",
      attr: { title: last?.lastError ?? (last?.lastTrigger ? `trigger: ${last.lastTrigger}` : "") },
    });
    const tip = r.errors.length ? r.errors.join("; ") : row.health === "stale" ? "changed since the schedules were applied" : row.health === "missed" ? "a fire time passed with no run recorded — is the schedule loaded?" : last?.lastError ?? "";
    el.createSpan({ cls: `aos-pulse-chip is-${row.health}`, text: row.health, attr: { title: tip } });

    const acts = el.createDiv({ cls: "aos-rt-rowactions" });
    const run = acts.createEl("a", { text: "▶", cls: "aos-link", href: "#", attr: { "aria-label": "run now", title: "run now" } });
    run.addEventListener("click", (e) => { e.preventDefault(); this.runNow(r.slug); });
    const toggle = acts.createEl("a", { text: r.enabled ? "on" : "off", cls: "aos-link", href: "#", attr: { title: r.enabled ? "disable" : "enable" } });
    toggle.addEventListener("click", (e) => { e.preventDefault(); void this.toggle(r); });
    const edit = acts.createEl("a", { text: "✎", cls: "aos-link", href: "#", attr: { title: "edit" } });
    edit.addEventListener("click", (e) => { e.preventDefault(); this.openEditor(r); });
  }

  // ── actions (every one spawns the runtime; the ledger/state file change re-renders the tab) ──

  private spawnEnv(): Record<string, string> {
    return { AOS_VAULT: this.plugin.vaultRoot(), AOS_CONFIG: path.join(this.plugin.claudeConfigDir(), "agenticos.json") };
  }

  private runNow(slug: string): void {
    this.plugin.runBrainScript(RUNNER, [slug, "--manual"], () => this.schedule(), { env: this.spawnEnv() });
  }

  private applySchedules(): void {
    this.plugin.runBrainScript(AOS_CLI, ["routines", "sync"], () => this.schedule(), { env: this.spawnEnv() });
  }

  private async toggle(r: Routine): Promise<void> {
    try {
      const after = await setRoutineEnabled(adapterOf(this.plugin.app), r.slug, !r.enabled);
      new Notice(`${r.slug}: ${after.enabled ? "enabled" : "disabled"}`);
      this.applySchedules();
    } catch (e) {
      new Notice(`toggle failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── editor drawer ──

  private openEditor(existing: Routine | null): void {
    const draft: RoutineDraft = existing
      ? (() => { const { errors, ...rest } = existing; void errors; return { ...rest, body: existing.body } as RoutineDraft; })()
      : { slug: "", schema: 1, name: "", kind: "prompt", schedule: "0 9 * * 1-5", enabled: true, body: "" };
    this.view.openDrawer(existing ? `Edit ${existing.slug}` : "New routine", (host) => this.renderEditor(host, draft, existing));
  }

  private renderEditor(host: HTMLElement, draft: RoutineDraft, existing: Routine | null): void {
    host.addClass("aos-rt-editor");
    if (existing?.guarded) host.createDiv({ cls: "aos-rt-guard", text: "guarded: the persona contract covers this duty — a schedule or body change asks for confirmation" });
    const field = (label: string): HTMLElement => { const f = host.createDiv({ cls: "aos-rt-field" }); f.createEl("label", { text: label }); return f; };
    const text = (label: string, value: string, onInput: (v: string) => void, opts: { disabled?: boolean; placeholder?: string } = {}): HTMLInputElement => {
      const input = field(label).createEl("input", { cls: "aos-rt-input", attr: { type: "text", value, placeholder: opts.placeholder ?? "" } });
      if (opts.disabled) input.disabled = true;
      input.addEventListener("input", () => onInput(input.value));
      return input;
    };

    const slugInput = text("slug", draft.slug, (v) => { draft.slug = v.trim(); }, { disabled: !!existing, placeholder: "morning-brief" });
    text("name", draft.name ?? "", (v) => { draft.name = v; if (!existing && !slugInput.value) { draft.slug = v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 41); slugInput.value = draft.slug; } });

    const kindSel = field("kind").createEl("select", { cls: "aos-rt-input" });
    for (const k of KINDS) kindSel.createEl("option", { text: k, value: k });
    kindSel.value = String(draft.kind ?? "prompt");

    const scheduleInput = text("schedule (cron: min hour day month weekday)", draft.schedule ?? "", (v) => { draft.schedule = v; preview(); }, { placeholder: "45 7 * * 1-5" });
    const previewEl = host.createDiv({ cls: "aos-rt-preview aos-dim" });
    const preview = () => {
      const expr = scheduleInput.value;
      const err = validateCron(expr);
      previewEl.empty();
      previewEl.toggleClass("is-error", !!err);
      if (err) { previewEl.setText(err); return; }
      previewEl.createDiv({ text: describe(expr) });
      for (const d of nextFire(expr, new Date(), 3)) previewEl.createDiv({ text: `  ${formatFire(d)}` });
    };
    preview();

    const enabledField = field("enabled");
    const enabledBox = enabledField.createEl("input", { attr: { type: "checkbox" } });
    enabledBox.checked = draft.enabled !== false;
    enabledBox.addEventListener("change", () => { draft.enabled = enabledBox.checked; });

    // Kind-specific fields live in one host that is rebuilt when the kind changes.
    const kindHost = host.createDiv();
    const renderKindFields = () => {
      kindHost.empty();
      const kind = kindSel.value as RoutineKind;
      draft.kind = kind;
      if (kind === "prompt") {
        const m = kindHost.createDiv({ cls: "aos-rt-field" }); m.createEl("label", { text: "model (blank = claude.model)" });
        const mi = m.createEl("input", { cls: "aos-rt-input", attr: { type: "text", value: draft.model ?? "" } });
        mi.addEventListener("input", () => { draft.model = mi.value.trim() || undefined; });
        const ef = kindHost.createDiv({ cls: "aos-rt-field" }); ef.createEl("label", { text: "effort" });
        const es = ef.createEl("select", { cls: "aos-rt-input" });
        es.createEl("option", { text: "(default)", value: "" });
        for (const e of EFFORTS) es.createEl("option", { text: e, value: e });
        es.value = draft.effort ?? "";
        es.addEventListener("change", () => { draft.effort = es.value || undefined; });
        const b = kindHost.createDiv({ cls: "aos-rt-field" }); b.createEl("label", { text: "budget USD per run (blank = routines.perRunUsd)" });
        const bi = b.createEl("input", { cls: "aos-rt-input", attr: { type: "text", value: draft.budgetUsd != null ? String(draft.budgetUsd) : "" } });
        bi.addEventListener("input", () => { const n = Number(bi.value); draft.budgetUsd = bi.value.trim() === "" ? undefined : n; });
      } else if (kind === "command") {
        const a = kindHost.createDiv({ cls: "aos-rt-field" }); a.createEl("label", { text: "argv (one argument per line, no shell)" });
        const ta = a.createEl("textarea", { cls: "aos-rt-input aos-rt-argv" });
        ta.rows = 4;
        ta.value = (draft.argv ?? []).join("\n");
        ta.addEventListener("input", () => { draft.argv = ta.value.split("\n").map((s) => s.trim()).filter(Boolean); });
      } else {
        kindHost.createDiv({ cls: "aos-dim aos-rt-note", text: `runs persona/duties/${draft.slug || "<slug>"}.md through run-duty.sh (persona caps and journal apply)` });
      }
    };
    kindSel.addEventListener("change", renderKindFields);
    renderKindFields();

    text("timeout seconds (blank = 1800)", draft.timeoutSec != null ? String(draft.timeoutSec) : "", (v) => { draft.timeoutSec = v.trim() === "" ? undefined : Number(v); });
    text("tags (comma separated)", (draft.tags ?? []).join(", "), (v) => { const t = v.split(",").map((s) => s.trim()).filter(Boolean); draft.tags = t.length ? t : undefined; });

    const bodyField = field("body (the prompt for a prompt routine; a note otherwise)");
    const body = bodyField.createEl("textarea", { cls: "aos-rt-input aos-rt-body" });
    body.rows = 8;
    body.value = draft.body ?? "";
    body.addEventListener("input", () => { draft.body = body.value; });

    const errorsEl = host.createDiv({ cls: "aos-rt-errors" });
    const actions = host.createDiv({ cls: "aos-capture-actions" });
    if (existing) {
      const del = actions.createEl("button", { text: "delete" });
      del.addEventListener("click", () => { void this.remove(existing); });
    }
    const save = actions.createEl("button", { text: existing ? "save" : "create", cls: "mod-cta" });
    save.addEventListener("click", () => { void this.save(draft, existing, errorsEl); });
  }

  private async save(draft: RoutineDraft, existing: Routine | null, errorsEl: HTMLElement): Promise<void> {
    errorsEl.empty();
    if (!SLUG_RE.test(draft.slug)) { errorsEl.setText('slug must be 2-41 chars of a-z, 0-9 and "-"'); return; }
    const adapter = adapterOf(this.plugin.app);
    const guarded = isGuardedChange(existing, draft);
    let confirmed = false;
    if (guarded) {
      confirmed = await ConfirmModal.ask(this.plugin.app, "Guarded routine",
        `${draft.slug} is one of the persona's duties. Its schedule and prompt are covered by the persona contract (persona/IDENTITY.md). Write the change anyway?`, "Write anyway");
      if (!confirmed) return;
    }
    try {
      const p = await writeRoutine(adapter, draft, { overwrite: !!existing, confirmed });
      new Notice(`✓ ${p.split("/").pop()}`);
      this.view.closeDrawer();
      await this.refresh();
      if (existing?.enabled !== false || draft.enabled) this.applySchedules();
    } catch (e) {
      errorsEl.setText(e instanceof GuardedRoutineError ? e.message : (e instanceof Error ? e.message : String(e)));
    }
  }

  private async remove(existing: Routine): Promise<void> {
    const ok = await ConfirmModal.ask(this.plugin.app, "Delete routine", `Delete ${ROUTINES_DIR}/${existing.slug}.md? Its schedule is removed on the next apply.`, "Delete");
    if (!ok) return;
    try {
      await deleteRoutine(adapterOf(this.plugin.app), existing.slug, { confirmed: true });
      new Notice(`deleted ${existing.slug}`);
      this.view.closeDrawer();
      await this.refresh();
      this.applySchedules();
    } catch (e) {
      new Notice(`delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
