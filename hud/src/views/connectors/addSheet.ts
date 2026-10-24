// addSheet.ts — Connectors' Add server (spec 2026-10-23-connectors-tab D18, A1, A2; the design canvas's Add sheet): a
// dialog with the server's Name, its Kind (a local command or a remote URL), the command or the URL, "Secrets and
// settings · names only" as `NAME ← $VAR` rows (a remote server's one row is its bearer token's variable), and "Add it
// to" for each enabled host. Review changes checks the form (data/mcpManage.ts checkAdd) and hands the spec back to
// ConnectorsTab, which runs the dry run and shows its exact commands before anything changes; the dialog runs nothing.
// It never asks for a secret's value, only for the variable that holds it.
import { App, Modal, setIcon } from "obsidian";
import { CONN_HOST_LABEL, type ConnHost } from "../../data/connectorsModel";
import { checkAdd, type AddForm, type AddSpec } from "../../data/mcpManage";
import { dialogId } from "../../ui/spaces/SpaceDialogs";

const WHERE: Record<ConnHost, string> = { claude: "user scope", codex: "config.toml" };

export function blankAddForm(hosts: readonly ConnHost[]): AddForm {
  return { name: "", kind: "local", command: "", url: "", secrets: [{ key: "", var: "" }], hosts: [...hosts] };
}

export class AddServerSheet extends Modal {
  private done = false;
  private form: AddForm;
  private error: string | null = null;

  constructor(app: App, private hosts: readonly ConnHost[], private taken: Partial<Record<ConnHost, ReadonlySet<string>>>, start: AddForm | null,
    private resolve: (r: { spec: AddSpec; form: AddForm } | null) => void) {
    super(app);
    const f = start ?? blankAddForm(hosts);
    this.form = { ...f, secrets: f.secrets.map((s) => ({ ...s })), hosts: f.hosts.filter((h) => hosts.includes(h)) };
    if (!this.form.hosts.length) this.form.hosts = [...hosts];
  }

  /** The spec to dry-run (and the form as it was, to open with next time), or null when cancelled. */
  static ask(app: App, hosts: readonly ConnHost[], taken: Partial<Record<ConnHost, ReadonlySet<string>>>, start: AddForm | null): Promise<{ spec: AddSpec; form: AddForm } | null> {
    return new Promise((resolve) => new AddServerSheet(app, hosts, taken, start, resolve).open());
  }

  onOpen(): void {
    this.modalEl.addClass("aos-con-addmodal");
    this.modalEl.setAttr("role", "dialog");
    this.modalEl.setAttr("aria-modal", "true");
    this.draw("name");
  }

  onClose(): void {
    if (!this.done) this.resolve(null);
    this.contentEl.empty();
  }

  /** Draws the form again (a kind, a row or a host changed), the focus on `focus`'s field. */
  private draw(focus: string | null = null): void {
    const { contentEl } = this;
    const f = this.form;
    contentEl.empty();
    contentEl.addClass("aos-con-addsheet");
    const titleId = dialogId("con-add-title");
    this.modalEl.setAttr("aria-labelledby", titleId);
    contentEl.createEl("h3", { text: "Add MCP server", attr: { id: titleId } });
    const form = contentEl.createEl("form", { cls: "aos-con-addform", attr: { novalidate: "" } });
    form.addEventListener("submit", (e) => { e.preventDefault(); this.review(); });

    const field = (label: string, key: "name" | "command" | "url", placeholder: string) => {
      const wrap = form.createEl("label", { cls: "aos-con-field" });
      wrap.createSpan({ cls: "aos-con-fieldlabel", text: label });
      const input = wrap.createEl("input", { cls: "aos-con-input", attr: { type: key === "url" ? "url" : "text", placeholder, spellcheck: "false", autocomplete: "off", "data-field": key } });
      input.value = f[key];
      input.addEventListener("input", () => { f[key] = input.value; });
      return input;
    };
    field("Name", "name", "github");

    const kind = form.createDiv({ cls: "aos-con-field" });
    kind.createSpan({ cls: "aos-con-fieldlabel", text: "Kind", attr: { id: dialogId("con-add-kind") } });
    const seg = kind.createDiv({ cls: "aos-con-seg", attr: { role: "radiogroup", "aria-label": "Kind" } });
    for (const [k, label] of [["local", "Local command"], ["remote", "Remote URL"]] as const) {
      const b = seg.createEl("button", { cls: `aos-con-segbtn${f.kind === k ? " is-on" : ""}`, text: label, attr: { type: "button", role: "radio", "aria-checked": String(f.kind === k), "data-kind": k, "data-field": `kind:${k}` } });
      b.addEventListener("click", () => { if (f.kind !== k) { f.kind = k; f.secrets = [{ key: "", var: "" }]; this.draw(`kind:${k}`); } });
    }
    if (f.kind === "local") field("Command", "command", "npx -y @modelcontextprotocol/server-github");
    else field("URL", "url", "https://mcp.example.com/mcp");

    const sec = form.createDiv({ cls: "aos-con-field aos-con-secrets" });
    sec.createSpan({ cls: "aos-con-fieldlabel", text: f.kind === "local" ? "Secrets and settings · names only" : "Bearer token · name only" });
    f.secrets.forEach((row, i) => {
      const line = sec.createDiv({ cls: "aos-con-secret", attr: { "data-row": String(i) } });
      if (f.kind === "local") {
        const key = line.createEl("input", { cls: "aos-con-input aos-con-key", attr: { type: "text", placeholder: "GITHUB_PERSONAL_ACCESS_TOKEN", "aria-label": "The name the server reads", spellcheck: "false", autocomplete: "off", "data-field": `key:${i}` } });
        key.value = row.key;
        key.addEventListener("input", () => { row.key = key.value; });
      } else line.createSpan({ cls: "aos-con-keyfixed", text: "Authorization: Bearer" });
      line.createSpan({ cls: "aos-con-arrow", text: "←", attr: { "aria-hidden": "true" } });
      const v = line.createEl("input", { cls: "aos-con-input aos-con-var", attr: { type: "text", placeholder: "$GITHUB_TOKEN", "aria-label": "The variable it comes from, by name", spellcheck: "false", autocomplete: "off", "data-field": `var:${i}` } });
      v.value = row.var;
      v.addEventListener("input", () => { row.var = v.value; });
      if (f.kind === "local" && f.secrets.length > 1) {
        const x = line.createEl("button", { cls: "aos-con-close aos-con-rowx", attr: { type: "button", "aria-label": "Remove this variable", title: "Remove this variable" } });
        setIcon(x, "x");
        x.addEventListener("click", () => { f.secrets.splice(i, 1); this.draw(`var:${Math.max(0, i - 1)}`); });
      }
    });
    if (f.kind === "local") {
      const more = sec.createEl("button", { cls: "aos-con-btn aos-con-small aos-con-addvar", text: "+ Add variable", attr: { type: "button" } });
      more.addEventListener("click", () => { f.secrets.push({ key: "", var: "" }); this.draw(`key:${f.secrets.length - 1}`); });
    }
    sec.createEl("p", { cls: "aos-con-note", text: "UniDeX keeps the variable's name, never its value. The server reads it from your environment each time it starts." });

    const to = form.createDiv({ cls: "aos-con-field aos-con-to" });
    to.createSpan({ cls: "aos-con-fieldlabel", text: "Add it to" });
    for (const h of this.hosts) {
      const lab = to.createEl("label", { cls: "aos-con-check", attr: { "data-host": h } });
      const box = lab.createEl("input", { attr: { type: "checkbox", "data-field": `host:${h}` } });
      box.checked = f.hosts.includes(h);
      box.addEventListener("change", () => {
        f.hosts = box.checked ? [...new Set([...f.hosts, h])] : f.hosts.filter((x) => x !== h);
        this.draw(`host:${h}`);
      });
      lab.createSpan({ cls: `aos-con-dot is-${h}`, attr: { "aria-hidden": "true" } });
      lab.createSpan({ text: CONN_HOST_LABEL[h] });
      lab.createSpan({ cls: "aos-con-scope", text: WHERE[h] });
    }
    if (f.kind === "local" && f.hosts.includes("codex")) to.createEl("p", { cls: "aos-con-note", text: "Codex's CLI takes no variable names: the review shows the one env_vars line to paste into its config.toml." });

    if (this.error) form.createEl("p", { cls: "aos-con-adderror", text: this.error, attr: { role: "alert" } });
    const acts = form.createDiv({ cls: "aos-capture-actions" });
    const cancel = acts.createEl("button", { text: "Cancel", attr: { type: "button" } });
    cancel.addEventListener("click", () => this.close());
    acts.createEl("button", { text: "Review changes", cls: "mod-cta", attr: { type: "submit", "data-field": "review" } });

    const el = focus ? contentEl.querySelector<HTMLElement>(`[data-field="${CSS.escape(focus)}"]`) : null;
    (el ?? contentEl.querySelector<HTMLElement>('[data-field="name"]'))?.focus();
  }

  private review(): void {
    const r = checkAdd(this.form, this.hosts, this.taken);
    if ("error" in r) { this.error = r.error; this.draw("review"); return; }
    this.done = true;
    this.resolve({ spec: r.spec, form: this.form });
    this.close();
  }
}
