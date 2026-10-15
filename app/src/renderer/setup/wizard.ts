// The first-run wizard (phase 5, I4; install-import B1, B2, B13, B14): what the page shows when no vault is attached. It
// checks what `aos init` needs and installs what is missing itself (main downloads each pinned tool, checks it and puts
// it in place, with its progress here; the logins run in a terminal shown here), asks which hosts (or none yet) and
// which folder, asks the Chief of Staff questions, runs `aos init` from the runtime the app carries, then lists what is
// left, step by step: the CLAUDE.md line as a diff, Codex's /hooks, a host to add later, and the PATH line. It ends in
// the Workbench. Every step is a call main checks (src/main/ipc/setup.ts); the page names a fix by id and never sends a
// command, a URL, a CLAUDE.md path or a profile path.

import type { AosBridge, BootInfo, ClaudeMdPreview, InstallRequest, PathLinePreview, PersonaAnswers, PreflightReport, SetupCheck, SetupEvent, SetupFixId } from "../../shared/ipc";
import { CHIEF_MODELS } from "../../shared/ipc";
import { chiefSummary } from "./chief";
import { BRAND } from "../../shared/brand";
import { addHostCommand, defaultHost, hostOffered, reconcileHost } from "./choices";
import { JobTerminal } from "./jobTerminal";

type Step = "check" | "choose" | "persona" | "install" | "finish";
type Host = InstallRequest["host"];

const STEPS: Array<[Step, string]> = [["check", "Check"], ["choose", "Choose"], ["persona", "Your agent"], ["install", "Install"], ["finish", "Finish"]];

/** What "Install what's missing" runs, in order: what `aos init` needs, then Ollama and its models. The hosts are the user's choice. */
export const ESSENTIALS: readonly SetupFixId[] = ["node", "uv", "ollama", "ollama-models"];

/** brain/scripts/persona/interview.js's rule for a name (main checks it again). */
export const NAME_RE = /^[A-Za-z][A-Za-z0-9 _-]{1,39}$/;

/** "a, b\nc" → ["a", "b", "c"] (the interview's toList). */
export function splitList(s: string): string[] { return s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean); }

export { defaultHost };

/** "12.3 of 50.6 MB" (or "12.3 MB" when the total is unknown). */
export function progressText(received: number, total: number | null): string {
  const mb = (n: number) => (n / 1e6).toFixed(n >= 1e8 ? 0 : 1);
  return total ? `${mb(received)} of ${mb(total)} MB` : `${mb(received)} MB`;
}

interface State {
  step: Step;
  report: PreflightReport | null;
  checking: boolean;
  /** The running job and, for a fix, which one. */
  job: { kind: SetupEvent["job"]; fix?: SetupFixId } | null;
  /** The running download's progress. */
  progress: { label: string; received: number; total: number | null } | null;
  /** The fix that just failed: its button reads Retry. */
  failed: SetupFixId | null;
  /** Install what's missing: the fixes still to run, in order. */
  queue: SetupFixId[];
  host: Host;
  /** The user clicked a host radio: their choice stands across checks while it is offered (F5). */
  hostPicked: boolean;
  vault: string;
  persona: PersonaAnswers;
  personaSkipped: boolean;
  installExit: number | null | undefined;
  claudeMd: ClaudeMdPreview | null;
  pathLine: PathLinePreview | null;
  /** Why the PATH line cannot be offered (its profile could not be read), else null. */
  pathLineError: string | null;
  /** Finish's "Add aos to my PATH" box. */
  addPath: boolean;
  error: string | null;
}

export function runSetup(root: HTMLElement, aos: AosBridge, info: BootInfo): void {
  const setup = info.setup;
  const s: State = {
    step: "check", report: null, checking: false, job: null, progress: null, failed: null, queue: [],
    host: "claude", hostPicked: false,
    vault: setup?.configuredVault ?? setup?.defaultVault ?? "~/AgenticOS",
    // local-first A4: the Chief of Staff's hosted models, preselected; each is sent only where its host is on.
    persona: { name: "", addressAs: "", voice: "", priorities: [], dutyModel: CHIEF_MODELS.claude, dutyCodexModel: CHIEF_MODELS.codex, dutyEffort: "medium", schedule: true },
    personaSkipped: false, installExit: undefined, claudeMd: null, pathLine: null, pathLineError: null, addPath: true, error: null,
  };

  const shell = root.createDiv({ cls: "aos-setup" });
  const head = shell.createDiv({ cls: "aos-setup-head" });
  head.createEl("h1", { text: `Set up ${BRAND.name}` });
  head.createEl("p", {
    cls: "aos-setup-sub",
    text: `${BRAND.name} ${info.appVersion}${setup?.payload ? ` · runtime ${setup.payload.version}` : ""}. Nothing is written until you choose Install or a download.`,
  });
  const nav = shell.createDiv({ cls: "aos-setup-steps" });
  const body = shell.createDiv({ cls: "aos-setup-body" });
  const termHost = shell.createDiv({ cls: "aos-setup-termhost" });
  let term: JobTerminal | null = null;

  /** The one terminal, made when a job first needs it and kept for the next; `keep` leaves its text (a queue's next fix). */
  function terminal(interactive: boolean, keep = false): JobTerminal {
    if (term && term.el.dataset.interactive === String(interactive)) { if (!keep) term.clear(); return term; }
    term?.dispose();
    termHost.empty();
    term = new JobTerminal(termHost, interactive ? { input: (d) => aos.setup.input(d), resize: (c, r) => aos.setup.resize(c, r) } : { rows: 16 });
    term.el.dataset.interactive = String(interactive);
    return term;
  }

  // What the e2e suite reads: the step, the report, and the terminal's text.
  (window as unknown as { aosSetup: unknown }).aosSetup = { state: s, log: () => term?.plain ?? "" };

  aos.setup.onEvent((ev) => {
    if (ev.type === "data") { term?.write(ev.data); return; }
    if (ev.type === "progress") { s.progress = { label: ev.label, received: ev.received, total: ev.total }; paintProgress(); return; }
    const job = s.job;
    s.job = null;
    s.progress = null;
    const code = ev.code;
    term?.note(code === 0 ? "✓ done" : `stopped (exit ${code ?? ev.signal ?? "?"})`);
    if (job?.kind === "fix") {
      s.failed = code === 0 ? null : job.fix ?? null;
      if (code !== 0) s.queue = [];
      render();
      void check().then(() => { if (code === 0) next(); });
    } else if (job?.kind === "install") {
      s.installExit = code;
      if (code === 0) { s.step = "finish"; loadFinish(); }
      render();
    }
  });

  async function check(): Promise<void> {
    s.checking = true;
    render();
    const r = await aos.setup.preflight();
    s.checking = false;
    if (r.ok) {
      const first = !s.report;
      s.report = r.data;
      // Inspection M2: after every check, not only the first, so a host logged in since replaces a "none" no longer offered.
      s.host = first ? defaultHost(r.data.hosts) : reconcileHost(s.host, r.data.hosts, s.hostPicked);
      s.error = null;
    } else s.error = r.error;
    render();
  }

  const checkOf = (id: SetupFixId): SetupCheck | undefined => s.report?.checks.find((c) => c.fix === id);

  function runFix(c: SetupCheck, keep = false): void {
    if (!c.fix || s.job) return;
    const t = terminal(c.fixKind === "terminal", keep);
    const size = t.size;
    const r = aos.setup.fix(c.fix, size.cols, size.rows);
    if (!r.ok) { s.error = `${c.fixLabel}: ${r.error}`; s.queue = []; render(); return; }
    s.job = { kind: "fix", fix: c.fix };
    s.progress = null;
    s.error = null;
    render();
    if (c.fixKind === "terminal") t.focus();
  }

  /** The next fix of the queue whose check still fails and can run; false when there is none. */
  function next(): boolean {
    while (s.queue.length) {
      const id = s.queue.shift() as SetupFixId;
      const c = checkOf(id);
      if (!c || c.state === "ok" || !c.fix || c.fixBlocked) continue;
      runFix(c, true);
      return true;
    }
    return false;
  }

  /** The essentials that are missing and can run (Ollama's models wait only for an Ollama the queue installs first). */
  const missingEssentials = (): SetupFixId[] => ESSENTIALS.filter((id) => {
    const c = checkOf(id);
    if (!c || c.state === "ok" || !c.fix) return false;
    if (!c.fixBlocked) return true;
    const ollama = s.report?.checks.find((x) => x.id === "ollama");
    return id === "ollama-models" && ollama?.fix === "ollama" && !ollama.fixBlocked;
  });

  function installMissing(): void {
    s.queue = missingEssentials();
    term?.clear();
    next();
  }

  function install(): void {
    // Never an install for a choice Choose does not show (M2): a host that logged out, or "none" once one is ready.
    if (!s.report || !hostOffered(s.host, s.report.hosts)) { s.host = reconcileHost(s.host, s.report?.hosts ?? { claude: false, codex: false }, s.hostPicked); s.step = "choose"; s.error = "Choose a host again: what is ready changed."; render(); return; }
    const req: InstallRequest = { host: s.host, vault: s.vault, persona: s.personaSkipped || s.host === "none" ? null : { ...s.persona } };
    terminal(false);
    const r = aos.setup.install(req);
    if (!r.ok) { s.error = r.error; s.installExit = undefined; render(); return; }
    s.job = { kind: "install" };
    s.installExit = undefined;
    s.error = null;
    s.step = "install";
    render();
  }

  function loadFinish(): void {
    if (s.host === "claude" || s.host === "both") { const r = aos.setup.claudeMd(); s.claudeMd = r.ok ? r.data : null; } else s.claudeMd = null;
    const p = aos.setup.pathLine();
    s.pathLine = p.ok ? p.data : null;
    s.pathLineError = p.ok ? null : p.error;
  }

  // ── steps ──────────────────────────────────────────────────────────

  function renderNav(): void {
    nav.empty();
    const at = STEPS.findIndex(([id]) => id === s.step);
    STEPS.forEach(([id, label], i) => {
      nav.createDiv({ cls: `aos-setup-step${i === at ? " is-active" : ""}${i < at ? " is-done" : ""}`, text: `${i + 1} ${label}`, attr: { "data-step": id } });
    });
  }

  const button = (parent: HTMLElement, text: string, onClick: () => void, o: { cta?: boolean; disabled?: boolean; title?: string; cls?: string } = {}): HTMLButtonElement => {
    const b = parent.createEl("button", { text, cls: `${o.cta ? "mod-cta " : ""}${o.cls ?? ""}`.trim() });
    b.disabled = !!o.disabled;
    if (o.title) b.title = o.title;
    b.addEventListener("click", onClick);
    return b;
  };

  /** A download's bar, under the row whose fix is running. */
  function progressBar(parent: HTMLElement): void {
    const wrap = parent.createDiv({ cls: "aos-setup-progress" });
    wrap.createDiv({ cls: "aos-setup-progress-label" });
    const bar = wrap.createDiv({ cls: "aos-setup-progress-bar", attr: { role: "progressbar", "aria-valuemin": "0" } });
    bar.createDiv({ cls: "aos-setup-progress-fill" });
    paintProgress();
  }

  /** Redraws only the bar (a download reports many times a second). */
  function paintProgress(): void {
    const wrap = body.querySelector<HTMLElement>(".aos-setup-progress");
    if (!wrap) return;
    const p = s.progress;
    const label = wrap.querySelector<HTMLElement>(".aos-setup-progress-label");
    const bar = wrap.querySelector<HTMLElement>(".aos-setup-progress-bar");
    const fill = wrap.querySelector<HTMLElement>(".aos-setup-progress-fill");
    wrap.toggleClass("is-idle", !p);
    if (label) label.textContent = p ? `${p.label} · ${progressText(p.received, p.total)}` : "Starting…";
    const pct = p?.total ? Math.min(100, Math.round((p.received / p.total) * 100)) : 0;
    if (bar) { bar.setAttribute("aria-valuemax", "100"); bar.setAttribute("aria-valuenow", String(pct)); bar.setAttribute("aria-label", label?.textContent ?? ""); }
    if (fill) fill.style.width = `${pct}%`;
  }

  function fixButton(row: HTMLElement, c: SetupCheck): void {
    if (!c.fix) return;
    const running = s.job?.kind === "fix" && s.job.fix === c.fix;
    const retry = s.failed === c.fix && !running;
    button(row, running ? "Running…" : retry ? "Retry" : c.fixLabel ?? "Fix", () => runFix(c), {
      cls: "aos-setup-fix", disabled: !!s.job || !!c.fixBlocked || s.checking,
      title: c.fixBlocked ?? (c.fixKind === "terminal" ? `Runs: ${c.fixCommand}` : c.fixCommand ?? ""),
    });
  }

  function renderCheck(el: HTMLElement): void {
    el.createEl("h2", { text: `What ${BRAND.name} needs` });
    if (setup?.reason === "no-vault" && setup.configuredVault) {
      const box = el.createDiv({ cls: "aos-setup-callout" });
      box.createSpan({ text: `agenticos.json names ${setup.configuredVault}, which is not there. If it is on a disk that is not connected, connect it and open it; otherwise set up a vault below.` });
      button(box, "Open it", () => { const r = aos.setup.finish(); if (!r.ok) { s.error = r.error; render(); } });
    }
    if (!setup?.payload) {
      el.createDiv({ cls: "aos-setup-callout is-warn", text: "This build of the app carries no runtime, so it cannot install. Install a release of the app, or run it with AOS_APP_PAYLOAD set to a release tree (`npm run payload` in app/)." });
    }
    el.createEl("p", { cls: "aos-setup-hint", text: `Node.js and uv are required. Ollama and its models are recommended: background work runs on them, on this Mac. Claude Code and Codex are the agents your sessions run in; you can add them now or later. ${BRAND.name} downloads each tool from its maker, checks it against a pinned checksum and signature, and only then installs it; nothing needs Homebrew or a terminal. A login runs in the terminal below.` });
    const list = el.createDiv({ cls: "aos-setup-checks" });
    if (!s.report) list.createDiv({ cls: "aos-setup-hint", text: s.checking ? "Checking…" : "" });
    for (const c of s.report?.checks ?? []) {
      const row = list.createDiv({ cls: `aos-setup-check is-${c.state}`, attr: { "data-check": c.id } });
      row.createSpan({ cls: "aos-setup-mark", text: c.state === "ok" ? "✓" : c.state === "warn" ? "!" : c.required ? "✗" : "○" });
      const what = row.createDiv({ cls: "aos-setup-what" });
      what.createDiv({ cls: "aos-setup-label", text: c.label });
      what.createDiv({ cls: "aos-setup-detail", text: c.detail });
      if (s.job?.kind === "fix" && s.job.fix === c.fix && c.fixKind === "download") progressBar(what);
      fixButton(row, c);
    }
    const foot = el.createDiv({ cls: "aos-setup-foot" });
    button(foot, s.checking ? "Checking…" : "Check again", () => void check(), { disabled: s.checking || !!s.job, cls: "aos-setup-recheck" });
    if (s.job?.kind === "fix") button(foot, "Stop", () => { s.queue = []; aos.setup.cancel(); }, { cls: "aos-setup-stop" });
    foot.createDiv({ cls: "aos-setup-spacer" });
    const missing = s.report ? missingEssentials() : [];
    if (missing.length && !s.job) {
      button(foot, "Install what's missing", () => installMissing(), {
        cls: "aos-setup-install-missing", disabled: s.checking,
        title: `Runs, one after another: ${missing.map((id) => checkOf(id)?.fixLabel ?? id).join(", ")}`,
      });
    }
    button(foot, "Continue", () => { s.step = "choose"; render(); }, { cta: !missing.length || !!s.report?.ready, cls: "aos-setup-next", disabled: !s.report?.ready || !setup?.payload || !!s.job });
  }

  function renderChoose(el: HTMLElement): void {
    const ready = s.report?.hosts ?? { claude: false, codex: false };
    const noHost = !ready.claude && !ready.codex;
    el.createEl("h2", { text: "Hosts and folder" });
    el.createEl("p", {
      cls: "aos-setup-hint",
      text: noHost
        ? `Neither Claude Code nor Codex is installed and logged in. You can install without one: your vault, its memory and the background work on this Mac are set up now; Sessions and the Chief of Staff wait until Claude Code or Codex is added.`
        : `${BRAND.name} works with Claude Code, Codex, or both. Only the ones that are installed and logged in can be chosen.`,
    });
    const hosts = el.createDiv({ cls: "aos-setup-hosts" });
    const options: Array<[Host, string, boolean]> = [["claude", "Claude Code", ready.claude], ["codex", "Codex", ready.codex], ["both", "Both", ready.claude && ready.codex]];
    // Always offered (F5): a Mac with a host may still install without one; the default is the host that is ready.
    options.push(["none", "No agent CLI yet", true]);
    for (const [id, label, ok] of options) {
      const lab = hosts.createEl("label", { cls: `aos-setup-host${ok ? "" : " is-disabled"}` });
      const input = lab.createEl("input", { attr: { type: "radio", name: "aos-host", value: id } });
      input.checked = s.host === id;
      input.disabled = !ok;
      input.addEventListener("change", () => { if (input.checked) { s.host = id; s.hostPicked = true; render(); } });
      lab.appendText(` ${label}`);
    }
    if (s.host === "none") el.createEl("p", { cls: "aos-setup-hint", attr: { "data-hint": "no-host" }, text: "Sessions and the Chief of Staff wait until Claude Code or Codex is added. Finish says how." });
    el.createEl("h3", { text: "Vault folder" });
    el.createEl("p", { cls: "aos-setup-hint", text: "Your notes, memory and the runtime live here, as plain Markdown. Files already there are kept." });
    const row = el.createDiv({ cls: "aos-setup-vault" });
    const input = row.createEl("input", { cls: "aos-setup-vault-input", attr: { type: "text", spellcheck: "false" } });
    input.value = s.vault;
    input.addEventListener("input", () => { s.vault = input.value; });
    button(row, "Choose…", () => void aos.setup.chooseVault().then((p) => { if (p) { s.vault = p; render(); } }));
    const foot = el.createDiv({ cls: "aos-setup-foot" });
    button(foot, "Back", () => { s.step = "check"; render(); });
    foot.createDiv({ cls: "aos-setup-spacer" });
    // No host, no Chief of Staff yet: straight to the install.
    if (s.host === "none") button(foot, "Install", () => install(), { cta: true, cls: "aos-setup-install", disabled: !s.vault.trim() });
    else button(foot, "Continue", () => { s.step = "persona"; render(); }, { cta: true, cls: "aos-setup-next", disabled: !s.vault.trim() });
  }

  function renderPersona(el: HTMLElement): void {
    el.createEl("h2", { text: "Your Chief of Staff" });
    el.createEl("p", { cls: "aos-setup-hint", text: `${BRAND.name} sets up an agent that keeps watch over your work, runs daily duties and files proposals for you to decide. Name it and say how it should work; \`aos persona\` changes this later.` });
    const form = el.createDiv({ cls: "aos-setup-form" });
    const p = s.persona;
    const field = (label: string, key: "name" | "addressAs" | "voice" | "dutyModel" | "dutyCodexModel", placeholder: string): HTMLInputElement => {
      const f = form.createDiv({ cls: "aos-setup-field" });
      f.createEl("label", { text: label });
      const input = f.createEl("input", { attr: { type: "text", placeholder, "data-field": key, spellcheck: "false" } });
      input.value = p[key];
      input.addEventListener("input", () => { p[key] = input.value; nameError(); chief.setText(chiefSummary(s.host, p)); });
      return input;
    };
    field("Name", "name", "Atlas");
    const err = form.createDiv({ cls: "aos-setup-error" });
    const nameError = (): void => {
      const bad = p.name.trim() !== "" && !NAME_RE.test(p.name.trim());
      err.setText(bad ? "Letters, digits, spaces, - and _; 2 to 40 characters, starting with a letter." : "");
      next.disabled = !NAME_RE.test(p.name.trim());
    };
    field("How it addresses you", "addressAs", "the user");
    field("Voice, in one line", "voice", "concise, direct, dry");
    const pf = form.createDiv({ cls: "aos-setup-field" });
    pf.createEl("label", { text: "What it should watch most (comma-separated)" });
    const pri = pf.createEl("textarea", { attr: { rows: "2", "data-field": "priorities" } });
    pri.value = p.priorities.join(", ");
    pri.addEventListener("input", () => { p.priorities = splitList(pri.value); });
    if (s.host === "claude" || s.host === "both") field("Duty model on Claude Code", "dutyModel", CHIEF_MODELS.claude);
    if (s.host === "codex" || s.host === "both") field("Duty model on Codex", "dutyCodexModel", CHIEF_MODELS.codex);
    const chief = form.createDiv({ cls: "aos-setup-hint", attr: { "data-field": "chief" } });
    chief.setText(chiefSummary(s.host, p));
    const ef = form.createDiv({ cls: "aos-setup-field" });
    ef.createEl("label", { text: "Effort for background duties" });
    const sel = ef.createEl("select", { attr: { "data-field": "dutyEffort" } });
    for (const v of ["low", "medium", "high"] as const) { const o = sel.createEl("option", { text: v, attr: { value: v } }); o.selected = p.dutyEffort === v; }
    sel.addEventListener("change", () => { p.dutyEffort = sel.value as PersonaAnswers["dutyEffort"]; });
    const sf = form.createEl("label", { cls: "aos-setup-check-field" });
    const cb = sf.createEl("input", { attr: { type: "checkbox", "data-field": "schedule" } });
    cb.checked = p.schedule;
    cb.addEventListener("change", () => { p.schedule = cb.checked; });
    sf.appendText(" Schedule the daily duties (launchd)");
    const foot = el.createDiv({ cls: "aos-setup-foot" });
    button(foot, "Back", () => { s.step = "choose"; render(); });
    foot.createDiv({ cls: "aos-setup-spacer" });
    button(foot, "Skip for now", () => { s.personaSkipped = true; install(); }, { cls: "aos-setup-skip", title: "Install without an agent; run `aos persona` later" });
    const next = button(foot, "Install", () => { s.personaSkipped = false; install(); }, { cta: true, cls: "aos-setup-install" });
    nameError();
  }

  function renderInstall(el: HTMLElement): void {
    el.createEl("h2", { text: "Installing" });
    const status = el.createDiv({ cls: "aos-setup-status" });
    if (s.job?.kind === "install") status.setText(`Running aos init for ${s.vault}. This takes a minute or two.`);
    else if (s.installExit === 0) status.setText("Installed.");
    else if (s.installExit !== undefined) {
      status.addClass("is-warn");
      status.setText(`aos init stopped (exit ${s.installExit ?? "?"}). The output below says why; fix it, then try again.`);
    }
    const foot = el.createDiv({ cls: "aos-setup-foot" });
    if (s.job?.kind === "install") button(foot, "Stop", () => aos.setup.cancel(), { cls: "aos-setup-stop", title: "Stops aos init; running it again keeps what it already wrote" });
    else {
      button(foot, "Back to the checks", () => { s.step = "check"; render(); void check(); });
      foot.createDiv({ cls: "aos-setup-spacer" });
      button(foot, "Try again", () => install(), { cta: true, cls: "aos-setup-retry" });
    }
  }

  /** One item of Finish's list: a heading, why, and the steps, in order. */
  function leftItem(el: HTMLElement, key: string, title: string, why: string, steps: string[]): HTMLElement {
    const sec = el.createDiv({ cls: "aos-setup-section", attr: { "data-section": key } });
    sec.createEl("h3", { text: title });
    if (why) sec.createEl("p", { cls: "aos-setup-hint", text: why });
    if (steps.length) {
      const ol = sec.createEl("ol", { cls: "aos-setup-steps-list" });
      for (const t of steps) ol.createEl("li", { text: t });
    }
    return sec;
  }

  const TERMINAL = "Open Terminal (in Applications ▸ Utilities).";

  function renderFinish(el: HTMLElement): void {
    el.createEl("h2", { text: "Almost there" });
    el.createEl("p", { cls: "aos-setup-hint", text: "What is left, step by step. None of it is needed to open the Workbench; each can be done later." });
    const aosCmd = s.pathLine?.onPath || s.pathLine?.present ? "aos" : "~/.local/bin/aos";
    if (s.host === "claude" || s.host === "both") {
      const sec = el.createDiv({ cls: "aos-setup-section", attr: { "data-section": "claude-md" } });
      sec.createEl("h3", { text: "Connect Claude Code" });
      sec.createEl("p", { cls: "aos-setup-hint", text: `Claude Code reads the vault's conventions (AGENTICOS.md) through one line in your CLAUDE.md. ${BRAND.name} adds it only if you say so.` });
      const md = s.claudeMd;
      if (!md) sec.createDiv({ cls: "aos-setup-hint", text: "Your CLAUDE.md could not be read." });
      else {
        const diff = sec.createDiv({ cls: "aos-setup-diff" });
        diff.createDiv({ cls: "aos-setup-diff-path", text: md.path });
        for (const l of md.diff) diff.createDiv({ cls: `aos-setup-diff-line is-${l.kind}`, text: `${l.kind === "add" ? "+ " : "  "}${l.text}` });
        const row = sec.createDiv({ cls: "aos-setup-foot" });
        if (md.present) row.createSpan({ cls: "aos-setup-ok", text: "✓ The line is in your CLAUDE.md." });
        else {
          button(row, "Add the line", () => {
            const r = aos.setup.applyClaudeMd();
            if (r.ok) s.claudeMd = r.data; else s.error = r.error;
            render();
          }, { cta: true, cls: "aos-setup-add-line" });
          row.createSpan({ cls: "aos-setup-hint", text: "or add it yourself later." });
        }
      }
    }
    if (s.host === "codex" || s.host === "both") {
      leftItem(el, "codex-hooks", "Trust the hooks in Codex",
        `Codex runs ${BRAND.name}'s hooks only once you trust them. It asks once, and they stay trusted across updates.`,
        [TERMINAL, "Type codex and press Return.", "Type /hooks and press Return.", "Trust each agenticos entry. Until you do, they do not run."]);
    }
    if (s.host === "none") {
      leftItem(el, "no-host", "Add Claude Code or Codex",
        "Sessions and the Chief of Staff wait until Claude Code or Codex is added. Your vault, its memory and the background work on this Mac run without one.",
        [TERMINAL,
          "Install one and sign in: Claude Code with curl -fsSL https://claude.ai/install.sh | bash, then claude auth login; or Codex with curl -fsSL https://chatgpt.com/codex/install.sh | sh, then codex login.",
          `Type ${addHostCommand(aosCmd, s.vault, info.home)} (or --host codex) and press Return. It keeps your files and adds the host.`]);
    } else if (s.personaSkipped) {
      leftItem(el, "persona", "Set up your Chief of Staff", "You skipped its questions; it starts once you answer them.",
        [TERMINAL, `Type ${aosCmd} persona and press Return, then answer its questions.`]);
    }
    for (const id of ["ollama", "ollama-models"] as const) {
      const c = checkOf(id) ?? s.report?.checks.find((x) => x.id === id);
      if (!c || c.state === "ok") continue;
      const sec = leftItem(el, id, id === "ollama" ? "Install Ollama" : "Download Ollama's models",
        `${c.detail}. Background work on this Mac waits for ${id === "ollama" ? "it" : `${s.report?.models.join(" and ") ?? "them"}`}.`, []);
      if (s.job?.kind === "fix" && s.job.fix === c.fix) progressBar(sec);
      const row = sec.createDiv({ cls: "aos-setup-foot" });
      fixButton(row, c);
    }
    const pl = s.pathLine;
    if (!pl && s.pathLineError) {
      const sec = el.createDiv({ cls: "aos-setup-section", attr: { "data-section": "path" } });
      sec.createEl("h3", { text: "Run aos from a terminal" });
      sec.createEl("p", { cls: "aos-setup-hint", text: `${s.pathLineError}. To run aos from a terminal, add export PATH="$HOME/.local/bin:$PATH" to your shell's profile yourself.` });
    }
    if (pl) {
      const sec = el.createDiv({ cls: "aos-setup-section", attr: { "data-section": "path" } });
      sec.createEl("h3", { text: "Run aos from a terminal" });
      if (pl.onPath || pl.present) sec.createDiv({ cls: "aos-setup-ok", text: `✓ ~/.local/bin is on your PATH${pl.present ? ` (${pl.file})` : ""}: aos, claude and codex run from any terminal.` });
      else {
        sec.createEl("p", { cls: "aos-setup-hint", text: `aos, and the Claude Code and Codex that ${BRAND.name} installs, live in ~/.local/bin, which a new terminal does not look in yet. Ticked, Open the Workbench appends this one line to ${pl.file}; unticked, nothing is written and the app still runs aos by its full path.` });
        const diff = sec.createDiv({ cls: "aos-setup-diff" });
        diff.createDiv({ cls: "aos-setup-diff-path", text: pl.file });
        diff.createDiv({ cls: "aos-setup-diff-line is-add", text: `+ ${pl.line}` });
        const lab = sec.createEl("label", { cls: "aos-setup-check-field" });
        const cb = lab.createEl("input", { cls: "aos-setup-add-path", attr: { type: "checkbox" } });
        cb.checked = s.addPath;
        cb.addEventListener("change", () => { s.addPath = cb.checked; });
        lab.appendText(" Add aos to my PATH");
      }
    }
    const foot = el.createDiv({ cls: "aos-setup-foot" });
    foot.createDiv({ cls: "aos-setup-spacer" });
    button(foot, "Open the Workbench", () => {
      if (pl && !pl.onPath && !pl.present && s.addPath) {
        const w = aos.setup.addToPath();
        if (!w.ok) { s.error = w.error; render(); return; }
        s.pathLine = w.data;
      }
      const r = aos.setup.finish();
      if (!r.ok) { s.error = r.error; render(); }
    }, { cta: true, cls: "aos-setup-open", disabled: !!s.job });
  }

  function render(): void {
    renderNav();
    body.empty();
    body.setAttr("data-step", s.step);
    ({ check: renderCheck, choose: renderChoose, persona: renderPersona, install: renderInstall, finish: renderFinish })[s.step](body);
    if (s.error) body.createDiv({ cls: "aos-setup-error is-shown", text: s.error });
    // The terminal shows while it has something to show: on the checks, the install, and a job Finish started.
    termHost.toggleClass("is-hidden", !term || (s.step !== "check" && s.step !== "install" && !(s.step === "finish" && s.job)));
    term?.refit();
  }

  render();
  void check();
  // No plugin, no commands: the menu shows the setup state.
  aos.ready({ commands: [] });
}
