// Settings ▸ Hosts (install-import B2): Claude Code and Codex, each on or off for this vault, its CLI installed and
// signed in, and the one next step: sign in (❯_ in a Code terminal), install it (the maker's installer, step by step:
// the setup wizard's checked downloads are not reachable once a vault is attached), or Add, which runs `aos hosts add
// <host>` through the `hosts` write surface. The state is `aos hosts status --json` (a background read), with the caches
// standing in until it answers; the model is data/hostsState.ts.
import { Notice } from "obsidian";
import type AgenticOSPlugin from "../../../main";
import type { WorkbenchView } from "../WorkbenchView";
import { readAgenticosJson, readProviderState, type SessionHost } from "../../data/aosConfig";
import { failureText } from "../../data/aosRun";
import { HOSTS, HOST_LABEL, addHostText, cachedHostsStatus, hostView, nextSteps, parseHostsStatus, type HostsStatus } from "../../data/hostsState";
import { ConfirmModal } from "../../ui/ConfirmModal";

/** A refused spawn's words (app/compat/src/guard.ts refuse; main's own in app/src/main/services/proc.ts): the surface is off. */
const SURFACE_OFF = /no write surface (?:that allows it is on|runs it)/;

export class HostsPanel {
  private status: HostsStatus | null = null;
  private checking = false;
  private checked = false;
  private checkError: string | null = null;
  private busy: SessionHost | null = null;
  private result: { host: SessionHost; ok: boolean; text: string; steps: string[]; off: boolean } | null = null;

  constructor(private readonly plugin: AgenticOSPlugin, private readonly view: WorkbenchView, private readonly rerender: () => void) {}

  /** Each time Settings opens, the hosts are asked again (a sign-in in a terminal meanwhile shows at once). */
  reopen(): void { this.checked = false; }

  render(parent: HTMLElement): void {
    // After this render: the check redraws the tab, which must not happen in the middle of drawing it.
    if (!this.checked) { this.checked = true; window.setTimeout(() => void this.check(), 0); }
    const st = this.status ?? cachedHostsStatus(readAgenticosJson(this.plugin.claudeConfigDir()), readProviderState(this.plugin.vaultRoot()));
    parent.createDiv({ cls: "aos-rt-subhead aos-dim", text: "HOSTS" });
    const box = parent.createDiv({ cls: "aos-st-section aos-st-hosts", attr: { "data-tour": "settings-host-list", "data-source": st.source } });
    box.createDiv({ cls: "aos-st-hostintro aos-dim", text: "The agents your sessions and the Chief of Staff run on. Add one to this vault once it is installed and signed in." });
    for (const h of HOSTS) {
      const v = hostView(h, st.hosts[h]);
      const row = box.createDiv({ cls: `aos-st-hostrow is-${v.state}`, attr: { "data-host": h, "data-state": v.state } });
      const head = row.createDiv({ cls: "aos-st-hosthead" });
      head.createSpan({ cls: "aos-st-hostname", text: v.label });
      head.createSpan({ cls: "aos-st-hoststate", text: v.text });
      const acts = head.createDiv({ cls: "aos-st-hostacts" });
      if (v.signIn) {
        const cmd = v.signIn;
        const b = acts.createEl("button", { cls: "aos-ws-action", text: `❯_ ${cmd}`, attr: { "data-act": `signin-${h}` } });
        b.setAttr("title", `Sign in to ${v.label} in a Code terminal, then ⟳ Check again`);
        b.addEventListener("click", () => this.view.runInTerm(cmd, { origin: "Settings" }));
      }
      if (v.add.shown) {
        const running = this.busy === h;
        const b = acts.createEl("button", { cls: `aos-ws-action${v.add.enabled ? " mod-cta" : ""}`, text: running ? "Adding…" : `Add ${v.label}`, attr: { "data-act": `add-${h}` } });
        b.disabled = !v.add.enabled || this.busy !== null;
        b.setAttr("title", v.add.why ?? `aos hosts add ${h}`);
        b.addEventListener("click", () => void this.add(h));
      }
      if (v.install) {
        const how = row.createDiv({ cls: "aos-st-hostinstall", attr: { "data-row": "install" } });
        how.createSpan({ cls: "aos-dim", text: `To install ${v.label}:` });
        const ol = how.createEl("ol", { cls: "aos-st-hoststeps" });
        for (const t of v.install) ol.createEl("li", { text: t });
      }
      if (this.result && this.result.host === h) this.renderResult(row);
    }
    const foot = box.createDiv({ cls: "aos-st-hostfoot" });
    const re = foot.createEl("button", { cls: "aos-ws-action", text: this.checking ? "Checking…" : "⟳ Check again", attr: { "data-act": "hosts-check" } });
    re.disabled = this.checking;
    re.setAttr("title", "Ask each host's CLI again whether it is installed and signed in (aos hosts status)");
    re.addEventListener("click", () => void this.check());
    foot.createSpan({
      cls: "aos-dim aos-st-hostsource",
      text: this.checkError ? `Could not check: ${this.checkError}` : st.source === "runtime" ? "Checked with each host's CLI." : "From the last known state; checking…",
    });
  }

  private renderResult(row: HTMLElement): void {
    const r = this.result!;
    const box = row.createDiv({ cls: `aos-st-hostresult ${r.ok ? "is-ok" : "is-err"}`, attr: { "data-row": "result" } });
    box.createDiv({ text: r.text });
    if (r.off) {
      const b = box.createEl("button", { cls: "aos-ws-action", text: `❯_ aos hosts add ${r.host}`, attr: { "data-act": `add-term-${r.host}` } });
      b.setAttr("title", "Run it in a Code terminal instead");
      b.addEventListener("click", () => this.view.runInTerm(`aos hosts add ${r.host}`, { origin: "Settings" }));
    }
    if (r.steps.length) {
      box.createDiv({ cls: "aos-dim", text: "Next:" });
      const ol = box.createEl("ol", { cls: "aos-st-hoststeps" });
      for (const s of r.steps) ol.createEl("li", { text: s });
    }
  }

  /** `aos hosts status --json`: the state as `aos hosts add` would find it. */
  async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    this.rerender();
    const r = await this.plugin.aosJson<unknown>(["hosts", "status", "--json"], 60_000);
    this.checking = false;
    const s = r.code === 0 ? parseHostsStatus(r.json) : null;
    if (s) { this.status = s; this.checkError = null; } else this.checkError = r.code === 0 ? "aos hosts status answered in an unexpected shape" : failureText(r);
    this.rerender();
  }

  private async add(h: SessionHost): Promise<void> {
    if (this.busy) return;
    const label = HOST_LABEL[h];
    const st = this.status ?? cachedHostsStatus(readAgenticosJson(this.plugin.claudeConfigDir()), readProviderState(this.plugin.vaultRoot()));
    const first = !HOSTS.some((x) => st.hosts[x].enabled);
    if (!(await ConfirmModal.ask(this.plugin.app, `Add ${label}?`, addHostText(h, first), `Add ${label}`))) return;
    this.busy = h;
    this.result = null;
    this.rerender();
    const r = await this.plugin.aos(["hosts", "add", h], 10 * 60_000);
    this.busy = null;
    if (r.code === 0) {
      this.result = { host: h, ok: true, text: `${label} is added to this vault.`, steps: nextSteps(r.stdout), off: false };
      new Notice(`${label} added: its plugin is installed and its instructions are in Brain ▸ Review.`, 8000);
    } else {
      const why = failureText(r);
      const off = SURFACE_OFF.test(why);
      this.result = { host: h, ok: false, text: off ? `Adding a host from here is off under the app's write surfaces (Hosts). Run it in a Code terminal instead.` : `${label} was not added: ${why}`, steps: [], off };
    }
    await this.check();
  }
}
