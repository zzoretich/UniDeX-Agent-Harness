// The first-run wizard (phase 5, I4): what the page shows when no vault is attached. It checks what `aos init` needs,
// offers a fix-it for each missing piece (run by main in a terminal shown here), asks which hosts and which folder,
// asks the Chief of Staff questions, runs `aos init` from the runtime the app carries, offers the CLAUDE.md line as a
// diff, and ends in the Workbench. Every step is a call main checks (src/main/ipc/setup.ts); the page names a fix by id
// and never sends a command or a CLAUDE.md path.

import type { AosBridge, BootInfo, ClaudeMdPreview, InstallRequest, PersonaAnswers, PreflightReport, SetupCheck, SetupEvent, SetupFixId } from "../../shared/ipc";
import { CHIEF_MODELS } from "../../shared/ipc";
import { chiefSummary } from "./chief";
import { BRAND } from "../../shared/brand";
import { JobTerminal } from "./jobTerminal";

type Step = "check" | "choose" | "persona" | "install" | "finish";
type Host = InstallRequest["host"];

const STEPS: Array<[Step, string]> = [["check", "Check"], ["choose", "Choose"], ["persona", "Your agent"], ["install", "Install"], ["finish", "Finish"]];

/** brain/scripts/persona/interview.js's rule for a name (main checks it again). */
export const NAME_RE = /^[A-Za-z][A-Za-z0-9 _-]{1,39}$/;

/** "a, b\nc" → ["a", "b", "c"] (the interview's toList). */
export function splitList(s: string): string[] { return s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean); }

/** The host to offer first: both when both are ready, else the one that is. */
export function defaultHost(ready: { claude: boolean; codex: boolean }): Host {
  return ready.claude && ready.codex ? "both" : ready.codex ? "codex" : "claude";
}

interface State {
  step: Step;
  report: PreflightReport | null;
  checking: boolean;
  /** The running job and, for a fix, which one. */
  job: { kind: SetupEvent["job"]; fix?: SetupFixId } | null;
  host: Host;
  vault: string;
  persona: PersonaAnswers;
  personaSkipped: boolean;
  installExit: number | null | undefined;
  claudeMd: ClaudeMdPreview | null;
  error: string | null;
}

export function runSetup(root: HTMLElement, aos: AosBridge, info: BootInfo): void {
  const setup = info.setup;
  const s: State = {
    step: "check", report: null, checking: false, job: null,
    host: "claude",
    vault: setup?.configuredVault ?? setup?.defaultVault ?? "~/AgenticOS",
    // local-first A4: the Chief of Staff's hosted models, preselected; each is sent only where its host is on.
    persona: { name: "", addressAs: "", voice: "", priorities: [], dutyModel: CHIEF_MODELS.claude, dutyCodexModel: CHIEF_MODELS.codex, dutyEffort: "medium", schedule: true },
    personaSkipped: false, installExit: undefined, claudeMd: null, error: null,
  };

  const shell = root.createDiv({ cls: "aos-setup" });
  const head = shell.createDiv({ cls: "aos-setup-head" });
  head.createEl("h1", { text: `Set up ${BRAND.name}` });
  head.createEl("p", {
    cls: "aos-setup-sub",
    text: `${BRAND.name} ${info.appVersion}${setup?.payload ? ` · runtime ${setup.payload.version}` : ""}. Nothing is written until you choose Install.`,
  });
  const nav = shell.createDiv({ cls: "aos-setup-steps" });
  const body = shell.createDiv({ cls: "aos-setup-body" });
  const termHost = shell.createDiv({ cls: "aos-setup-termhost" });
  let term: JobTerminal | null = null;

  /** The one terminal, made when a job first needs it and kept for the next. */
  function terminal(interactive: boolean): JobTerminal {
    if (term && term.el.dataset.interactive === String(interactive)) { term.clear(); return term; }
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
    const job = s.job;
    s.job = null;
    const code = ev.code;
    term?.note(code === 0 ? "✓ done" : `stopped (exit ${code ?? ev.signal ?? "?"})`);
    if (job?.kind === "fix") { render(); void check(); }
    else if (job?.kind === "install") {
      s.installExit = code;
      if (code === 0) { s.step = "finish"; loadClaudeMd(); }
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
      if (first) s.host = defaultHost(r.data.hosts);
      s.error = null;
    } else s.error = r.error;
    render();
  }

  function runFix(c: SetupCheck): void {
    if (!c.fix || s.job) return;
    const t = terminal(true);
    const size = t.size;
    const r = aos.setup.fix(c.fix, size.cols, size.rows);
    if (!r.ok) { s.error = `${c.fixLabel}: ${r.error}`; render(); return; }
    s.job = { kind: "fix", fix: c.fix };
    s.error = null;
    render();
    t.focus();
  }

  function install(): void {
    const req: InstallRequest = { host: s.host, vault: s.vault, persona: s.personaSkipped ? null : { ...s.persona } };
    terminal(false);
    const r = aos.setup.install(req);
    if (!r.ok) { s.error = r.error; s.installExit = undefined; render(); return; }
    s.job = { kind: "install" };
    s.installExit = undefined;
    s.error = null;
    s.step = "install";
    render();
  }

  function loadClaudeMd(): void {
    if (s.host === "codex") { s.claudeMd = null; return; }
    const r = aos.setup.claudeMd();
    s.claudeMd = r.ok ? r.data : null;
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
    el.createEl("p", { cls: "aos-setup-hint", text: "Node, Ollama, Python and uv are required, and at least one of Claude Code or Codex, installed and logged in. Ollama's two models (about 7.2 GB) are not required, but background work runs on Ollama once it answers, so download them too. A fix runs in the terminal below; it may ask for your password." });
    const list = el.createDiv({ cls: "aos-setup-checks" });
    if (!s.report) list.createDiv({ cls: "aos-setup-hint", text: s.checking ? "Checking…" : "" });
    for (const c of s.report?.checks ?? []) {
      const row = list.createDiv({ cls: `aos-setup-check is-${c.state}`, attr: { "data-check": c.id } });
      row.createSpan({ cls: "aos-setup-mark", text: c.state === "ok" ? "✓" : c.state === "warn" ? "!" : c.required ? "✗" : "○" });
      const what = row.createDiv({ cls: "aos-setup-what" });
      what.createDiv({ cls: "aos-setup-label", text: c.label });
      what.createDiv({ cls: "aos-setup-detail", text: c.detail });
      if (c.fix) {
        const running = s.job?.kind === "fix" && s.job.fix === c.fix;
        button(row, running ? "Running…" : c.fixLabel ?? "Fix", () => runFix(c), {
          cls: "aos-setup-fix", disabled: !!s.job || !!c.fixBlocked || s.checking,
          title: c.fixBlocked ?? `Runs: ${c.fixCommand}`,
        });
      }
    }
    const foot = el.createDiv({ cls: "aos-setup-foot" });
    button(foot, s.checking ? "Checking…" : "Check again", () => void check(), { disabled: s.checking || !!s.job, cls: "aos-setup-recheck" });
    if (s.job?.kind === "fix") button(foot, "Stop", () => aos.setup.cancel(), { cls: "aos-setup-stop" });
    foot.createDiv({ cls: "aos-setup-spacer" });
    button(foot, "Continue", () => { s.step = "choose"; render(); }, { cta: true, cls: "aos-setup-next", disabled: !s.report?.ready || !setup?.payload || !!s.job });
  }

  function renderChoose(el: HTMLElement): void {
    const ready = s.report?.hosts ?? { claude: false, codex: false };
    el.createEl("h2", { text: "Hosts and folder" });
    el.createEl("p", { cls: "aos-setup-hint", text: `${BRAND.name} works with Claude Code, Codex, or both. Only the ones that are installed and logged in can be chosen.` });
    const hosts = el.createDiv({ cls: "aos-setup-hosts" });
    const options: Array<[Host, string, boolean]> = [["claude", "Claude Code", ready.claude], ["codex", "Codex", ready.codex], ["both", "Both", ready.claude && ready.codex]];
    for (const [id, label, ok] of options) {
      const lab = hosts.createEl("label", { cls: `aos-setup-host${ok ? "" : " is-disabled"}` });
      const input = lab.createEl("input", { attr: { type: "radio", name: "aos-host", value: id } });
      input.checked = s.host === id;
      input.disabled = !ok;
      input.addEventListener("change", () => { if (input.checked) s.host = id; });
      lab.appendText(` ${label}`);
    }
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
    button(foot, "Continue", () => { s.step = "persona"; render(); }, { cta: true, cls: "aos-setup-next", disabled: !s.vault.trim() });
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
    if (s.host !== "codex") field("Duty model on Claude Code", "dutyModel", CHIEF_MODELS.claude);
    if (s.host !== "claude") field("Duty model on Codex", "dutyCodexModel", CHIEF_MODELS.codex);
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

  function renderFinish(el: HTMLElement): void {
    el.createEl("h2", { text: "Almost there" });
    if (s.host !== "codex") {
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
    if (s.host !== "claude") {
      const sec = el.createDiv({ cls: "aos-setup-section", attr: { "data-section": "codex-hooks" } });
      sec.createEl("h3", { text: "Trust the hooks in Codex" });
      sec.createEl("p", { cls: "aos-setup-hint", text: "Codex runs AgenticOS's hooks only once you trust them: open codex in a terminal, run /hooks, and trust the agenticos entries. It asks once." });
    }
    const foot = el.createDiv({ cls: "aos-setup-foot" });
    foot.createDiv({ cls: "aos-setup-spacer" });
    button(foot, "Open the Workbench", () => {
      const r = aos.setup.finish();
      if (!r.ok) { s.error = r.error; render(); }
    }, { cta: true, cls: "aos-setup-open" });
  }

  function render(): void {
    renderNav();
    body.empty();
    body.setAttr("data-step", s.step);
    ({ check: renderCheck, choose: renderChoose, persona: renderPersona, install: renderInstall, finish: renderFinish })[s.step](body);
    if (s.error) body.createDiv({ cls: "aos-setup-error is-shown", text: s.error });
    // The terminal shows while it has something to show: on the checks and the install.
    termHost.toggleClass("is-hidden", !term || (s.step !== "check" && s.step !== "install"));
    term?.refit();
  }

  render();
  void check();
  // No plugin, no commands: the menu shows the setup state.
  aos.ready({ commands: [] });
}
