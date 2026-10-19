// NewSpaceModal.ts — New space (spec 2026-10-09-spaces-redesign D15; the Manage mock's first frame): a name, shown as
// the folder it makes; a template (Blank, Code repo, Clone from GitHub); and "Open with", the hosts the Code deck offers
// (TerminalLauncher.choices(): an agent that is on and ready, or Terminal), starting on the one ⌘T starts. The dialog
// only collects; SpacesTab runs `aos workspace new <slug> [--git] --pin --json` (Blank, Code repo) or
// `new <slug> --empty --json` then the typed clone line in a visible shell (Clone, never a runtime `git clone`). The
// pure parts (the slug check, the GitHub URL rule, the clone line, the host options) are exported for
// NewSpaceModal.test.ts.
import { Modal } from "obsidian";
import type { App } from "obsidian";
import * as path from "path";
import { KEBAB_RE, workspaceArgs } from "../../data/spacesModel";
import { SCRATCH, TERM_HOST_LABEL, isReserved, slugify } from "../../data/terminalLaunch";
import type { TermHost, TermHostChoice } from "../../data/terminalLaunch";
import { shq } from "../../data/skills";
import { dialogButton, dialogId, dialogShell, fieldLabel, setError, wireField } from "./SpaceDialogs";

// ── the model ──

export type SpaceTemplate = "blank" | "code" | "clone";
export const SPACE_TEMPLATES: ReadonlyArray<{ id: SpaceTemplate; label: string; detail: string }> = [
  { id: "blank", label: "Blank folder", detail: "README.md, CLAUDE.md and AGENTS.md for notes, plans and handoffs; no git." },
  { id: "code", label: "Code repo", detail: "The same stubs in a folder that is its own git repository." },
  { id: "clone", label: "Clone from GitHub", detail: "Paste a repository URL: a Code terminal clones it here, then writes the stubs." },
];

export interface SlugCheck {
  slug: string;
  /** The folder it makes, ~-shortened: the mock's line under NAME. Null when there is no slug. */
  where: string | null;
  /** Why it cannot be made, or null. */
  problem: string | null;
}

/**
 * The name typed in New space as the folder it makes (D15): its slug, and why not when it cannot be one. The runtime
 * checks again (RESERVED, scratch, an existing folder, a name an archived workspace holds); the page's KEBAB rule means
 * the name confirmed here is the one made.
 */
export function newSpaceName(name: string, o: { vault: string; home: string; existing: readonly string[]; archived: readonly string[] }): SlugCheck {
  const typed = String(name ?? "");
  const slug = slugify(typed);
  const where = slug ? tildePath(path.join(o.vault, "workspaces", slug), o.home) : null;
  const out = (problem: string | null): SlugCheck => ({ slug, where, problem });
  if (!typed.trim()) return out("Type a name");
  if (!slug) return out("Use a letter or digit");
  if (slug === SCRATCH) return out("scratch is the shared Scratch workspace: pick another name");
  if (isReserved(typed, slug)) return out(`"${slug}" is reserved: try ${slug.replace(/^_+/, "")}-notes`);
  if (!KEBAB_RE.test(slug)) return out("Use at most 64 letters, digits and dashes");
  const lower = (xs: readonly string[]) => new Set(xs.map((x) => String(x).toLowerCase()));
  if (lower(o.existing).has(slug)) return out(`workspaces/${slug} already exists: pick it in the list`);
  if (lower(o.archived).has(slug)) return out(`An archived workspace holds ${slug}: restore it instead`);
  return out(null);
}

/**
 * Rename's check (D17): New space's name rules in Rename's words, since "pick it in the list" and "restore it instead"
 * are New space's advice. Its name now, or nothing typed, is a quiet hint rather than an error; either way the move
 * waits for a new name.
 */
export function renameName(typed: string, current: string, o: { vault: string; home: string; existing: readonly string[]; archived: readonly string[] }): { slug: string; problem: string | null; quiet: boolean } {
  const c = newSpaceName(typed, o);
  if (!String(typed ?? "").trim()) return { slug: "", problem: "Type a new name", quiet: true };
  if (c.slug && c.slug === String(current).toLowerCase()) return { slug: c.slug, problem: "That is its name now", quiet: true };
  let problem = c.problem;
  if (problem?.endsWith(": pick it in the list")) problem = `workspaces/${c.slug} already exists: pick another name`;
  else if (problem?.endsWith(": restore it instead")) problem = `An archived workspace holds ${c.slug}: pick another name`;
  return { slug: c.slug, problem, quiet: false };
}

function tildePath(abs: string, home: string): string {
  return home && (abs === home || abs.startsWith(`${home}/`)) ? `~${abs.slice(home.length)}` : abs;
}

/**
 * The GitHub URL rule (D15; the plan's Mechanics › PR 3 › New): an https URL of a GitHub repository, or the same owner
 * and repository in GitHub's SSH form (user git, host github.com, path <owner>/<repo>.git). Nothing else is typed into a
 * terminal: no quotes, spaces, `..`, other hosts, `ext::` transports or option-shaped values.
 */
export const GITHUB_HTTPS_RE = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?(?:\.git)?$)[A-Za-z0-9._-]{1,100}?(?:\.git)?$/;
/** The SSH form; `\x40` is the separator between the user and the host. */
export const GITHUB_SSH_RE = /^git\x40github\.com:[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?\.git$)[A-Za-z0-9._-]{1,100}?\.git$/;

/** The URL to clone when it passes the rule (outer whitespace trimmed), else null. */
export function githubCloneUrl(typed: string): string | null {
  const u = String(typed ?? "").trim();
  return GITHUB_HTTPS_RE.test(u) || GITHUB_SSH_RE.test(u) ? u : null;
}

export const CLONE_URL_HINT = "A GitHub repository: https://github.com/<owner>/<repo>, or its SSH form ending in .git";

/**
 * What the shell types in the new, empty folder (D15): `git clone -- '<url>' . && aos workspace stubs <slug> --pin`,
 * with the URL quoted and only a slug that passes KEBAB (the one `new` returned). The leading space keeps it out of a
 * history that ignores spaced lines. Throws on anything else, before a terminal opens.
 */
export function cloneLine(url: string, slug: string): string {
  const u = githubCloneUrl(url);
  if (!u) throw new Error(`Not a GitHub repository URL: ${CLONE_URL_HINT}`);
  if (!KEBAB_RE.test(slug)) throw new Error(`Not a workspace name the clone line can carry: ${JSON.stringify(String(slug).slice(0, 60))}`);
  return ` git clone -- ${shq(u)} . && aos workspace stubs ${slug} --pin`;
}

/** The verb New space runs for a template (Clone makes an empty, unpinned folder; its line pins it after the clone). */
export function newSpaceArgs(template: SpaceTemplate, slug: string): string[] {
  return template === "clone" ? workspaceArgs.new(slug, { empty: true }) : workspaceArgs.new(slug, { git: template === "code", pin: true });
}

export interface OpenWithOption { host: TermHost; label: string; disabled: boolean; reason: string | null }

/** "Open with": the hosts that are on (host parity: never one that is off), one not logged in off with its reason, and
 *  Terminal. */
export function openWithOptions(choices: TermHostChoice[]): OpenWithOption[] {
  return choices
    .filter((c) => !c.hidden)
    .map((c) => ({ host: c.host, label: c.host === "shell" ? "Terminal" : c.label, disabled: !c.ready, reason: c.ready ? null : c.reason ?? `${c.label} is not ready` }));
}

/** The option it starts on: the host ⌘T starts (TerminalLauncher.quickHost) when it is offered and ready, else the
 *  first ready agent, else Terminal. */
export function defaultOpenWith(options: OpenWithOption[], quick: TermHost | null): TermHost {
  const on = options.filter((o) => !o.disabled);
  if (quick && on.some((o) => o.host === quick)) return quick;
  return on.find((o) => o.host !== "shell")?.host ?? "shell";
}

/** What the dialog hands SpacesTab. */
export interface NewSpaceRequest { name: string; slug: string; template: SpaceTemplate; url: string | null; host: TermHost }

// ── the dialog ──

export interface NewSpaceOptions {
  vault: string;
  home: string;
  /** Folder names under workspaces/ and the names archived workspaces hold. */
  existing: string[];
  archived: string[];
  choices: TermHostChoice[];
  quick: TermHost | null;
  /** Makes it: answers an error to show, or null when it is done (the dialog then closes). */
  create(req: NewSpaceRequest): Promise<string | null>;
}

export class NewSpaceModal extends Modal {
  private template: SpaceTemplate = "blank";
  private host: TermHost;
  private busy = false;

  constructor(app: App, private o: NewSpaceOptions) {
    super(app);
    this.host = defaultOpenWith(openWithOptions(o.choices), o.quick);
  }

  /** Escape, a click outside and ✕ wait while the space is made, so a refusal is shown (Cancel is disabled then too). */
  close(): void {
    if (this.busy) return;
    super.close();
  }

  onOpen(): void {
    const shell = dialogShell(this, { cls: "mod-spc-new", title: "New space" });
    const form = shell.body.createEl("form", { cls: "aos-spc-form", attr: { novalidate: "true" } });
    form.addEventListener("submit", (ev) => { ev.preventDefault(); void go(); });

    const nameField = fieldLabel(form, "NAME");
    const name = nameField.createEl("input", { cls: "aos-spc-input", attr: { type: "text", spellcheck: "false", placeholder: "trip-planner", "data-spc-field": "name" } });
    const nameHint = nameField.createSpan({ cls: "aos-spc-fhint aos-spc-mono", attr: { "data-spc-field": "where" } });
    const nameInvalid = wireField(nameField, name, nameHint);

    const tpl = form.createEl("fieldset", { cls: "aos-spc-fieldset" });
    tpl.createEl("legend", { cls: "aos-spc-flabel", text: "START FROM" });
    const group = dialogId("tpl");
    for (const t of SPACE_TEMPLATES) {
      const row = tpl.createEl("label", { cls: `aos-spc-choice${t.id === this.template ? " is-on" : ""}`, attr: { "data-template": t.id } });
      const r = row.createEl("input", { attr: { type: "radio", name: group, value: t.id } });
      r.checked = t.id === this.template;
      const txt = row.createSpan({ cls: "aos-spc-choicetext" });
      txt.createSpan({ cls: "aos-spc-choicename", text: t.label });
      txt.createSpan({ cls: "aos-spc-choicedetail", text: t.detail });
      r.addEventListener("change", () => { if (r.checked) { this.template = t.id; draw(); } });
    }

    const urlField = fieldLabel(form, "GITHUB URL");
    urlField.addClass("aos-spc-clonefield");
    const url = urlField.createEl("input", { cls: "aos-spc-input aos-spc-mono", attr: { type: "text", spellcheck: "false", placeholder: "https://github.com/owner/repo", "data-spc-field": "url" } });
    const urlHint = urlField.createSpan({ cls: "aos-spc-fhint" });
    const urlInvalid = wireField(urlField, url, urlHint);

    const hosts = form.createEl("fieldset", { cls: "aos-spc-fieldset" });
    hosts.createEl("legend", { cls: "aos-spc-flabel", text: "OPEN WITH" });
    const hostGroup = dialogId("host");
    const options = openWithOptions(this.o.choices);
    const hostRow = hosts.createDiv({ cls: "aos-spc-hostpick" });
    for (const h of options) {
      const row = hostRow.createEl("label", { cls: `aos-spc-hostopt${h.disabled ? " is-off" : ""}`, attr: { "data-host": h.host, ...(h.reason ? { title: h.reason } : {}) } });
      const r = row.createEl("input", { attr: { type: "radio", name: hostGroup, value: h.host } });
      r.checked = h.host === this.host;
      r.disabled = h.disabled;
      row.createSpan({ text: h.label });
      r.addEventListener("change", () => { if (r.checked) { this.host = h.host; draw(); } });
    }
    for (const h of options.filter((x) => x.disabled && x.reason)) hosts.createSpan({ cls: "aos-spc-fhint", text: h.reason ?? "" });

    const note = form.createEl("p", { cls: "aos-spc-dlgnote" });

    const err = shell.foot.createDiv({ cls: "aos-spc-dlgerr", attr: { role: "alert" } });
    shell.foot.createSpan({ cls: "aos-spc-grow" });
    const cancel = dialogButton(shell.foot, "Cancel", { cls: "aos-spc-cancel" });
    const ok = dialogButton(shell.foot, "Create space", { primary: true, cls: "aos-spc-confirm" });
    cancel.addEventListener("click", () => this.close());
    ok.addEventListener("click", () => void go());

    const state = (): { check: SlugCheck; cloneUrl: string | null; ready: boolean } => {
      const check = newSpaceName(name.value, this.o);
      const cloneUrl = this.template === "clone" ? githubCloneUrl(url.value) : null;
      const hostOk = options.some((x) => x.host === this.host && !x.disabled);
      return { check, cloneUrl, ready: !check.problem && hostOk && (this.template !== "clone" || !!cloneUrl) };
    };
    const draw = (): void => {
      const s = state();
      nameHint.setText(name.value.trim() && s.check.problem ? s.check.problem : s.check.where ?? "workspaces/<name>");
      nameHint.toggleClass("is-error", !!name.value.trim() && !!s.check.problem);
      nameInvalid(!!name.value.trim() && !!s.check.problem);
      for (const el of Array.from(tpl.querySelectorAll<HTMLElement>(".aos-spc-choice"))) el.toggleClass("is-on", el.getAttr("data-template") === this.template);
      urlField.toggleClass("is-hidden", this.template !== "clone");
      urlHint.setText(url.value.trim() && !s.cloneUrl ? CLONE_URL_HINT : "Cloned in a Code terminal you can see; nothing runs in the background.");
      urlHint.toggleClass("is-error", !!url.value.trim() && !s.cloneUrl);
      urlInvalid(!!url.value.trim() && !s.cloneUrl);
      const agent = this.host === "shell" ? null : TERM_HOST_LABEL[this.host];
      note.setText(this.template === "clone"
        ? `No agent starts in a fresh clone: when the clone line ends, the dossier offers ${agent ? `Start ${agent} here` : "a session here"}.`
        : `Pinned, then opened in Code${agent ? ` with ${agent}` : " in a terminal"}${this.template === "code" ? " after git init" : ""}.`);
      ok.setText(this.template === "clone" ? "Create and clone" : "Create space");
      ok.disabled = this.busy || !s.ready;
    };
    name.addEventListener("input", () => { setError(err, null); draw(); });
    url.addEventListener("input", () => { setError(err, null); draw(); });
    for (const el of [name, url]) el.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); void go(); } });

    const go = async (): Promise<void> => {
      const s = state();
      if (this.busy || !s.ready) return;
      this.busy = true;
      ok.disabled = true;
      cancel.disabled = true;
      setError(err, null);
      let failed: string | null = null;
      try { failed = await this.o.create({ name: name.value.trim(), slug: s.check.slug, template: this.template, url: s.cloneUrl, host: this.host }); }
      catch (e) { failed = e instanceof Error ? e.message : String(e); }
      this.busy = false;
      cancel.disabled = false;
      if (!failed) { this.close(); return; }
      setError(err, failed);
      draw();
    };
    draw();
    name.focus();
  }

  onClose(): void { this.contentEl.empty(); }
}
