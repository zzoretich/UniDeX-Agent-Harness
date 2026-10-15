import { Notice } from "obsidian";
import type { TAbstractFile } from "obsidian";
import * as path from "path";
import type AgenticOSPlugin from "../../main";
import type { WorkbenchView } from "./WorkbenchView";
import { readAgenticosJson, sessionHosts, SessionHost } from "../data/aosConfig";
import {
  SkillsCache, SkillRow, SKILLS_PATH, SKILL_HOSTS, emptySkills, readSkills, skillsStale, groupSkills, filterSkills,
  skillCounts, sourceLabel, statusChip, runCommand, asOf,
} from "../data/skills";
import { formatAgo } from "./RoutinesTab";
import { shell } from "../host";

const AOS_CLI = "brain/scripts/cli/aos.js";
const HOST_LABEL: Record<SessionHost, string> = { claude: "Claude Code", codex: "Codex" };
const SHAREABLE = new Set(["universal", "pending", "excluded"]);

/**
 * SKILLS — every Claude Code and Codex skill from brain/_index/skills.json (spec 2026-09-23-universal-skills D7), written
 * by the runtime's `aos skills sync`, which also mirrors each host's user skills into the other host's folder. Two
 * sections: your skills (shared across hosts) and plugin skills and built-ins (listed only). A row runs its skill in a
 * fresh Term session on either host, copies the invocation, opens the SKILL.md, and shares or unshares it. The tab never
 * writes a skill itself: every action spawns the runtime, and the cache's file event re-renders. Logic lives in
 * src/data/skills.ts; this class only renders and wires.
 */
export class SkillsTab {
  private host: HTMLElement | null = null;
  private listHost: HTMLElement | null = null;
  private cache: SkillsCache = emptySkills();
  private hosts: SessionHost[] = ["claude"];
  private query = "";
  private syncAt = 0;
  private listenersRegistered = false;
  private refreshDebounce: number | null = null;

  constructor(private plugin: AgenticOSPlugin, private view: WorkbenchView) {}

  mount(host: HTMLElement): void {
    this.host = host;
    if (!this.listenersRegistered) {
      this.listenersRegistered = true;
      const watch = (f: TAbstractFile) => { if (f.path === SKILLS_PATH) this.schedule(); };
      this.view.registerEvent(this.plugin.app.vault.on("modify", watch));
      this.view.registerEvent(this.plugin.app.vault.on("create", watch));
    }
    void this.refresh();
  }

  unmount(): void {
    if (this.refreshDebounce !== null) { window.clearTimeout(this.refreshDebounce); this.refreshDebounce = null; }
  }

  private schedule(): void {
    if (this.refreshDebounce !== null) window.clearTimeout(this.refreshDebounce);
    this.refreshDebounce = window.setTimeout(() => void this.refresh(), 250);
  }

  async refresh(): Promise<void> {
    this.cache = readSkills(this.plugin.vaultRoot());
    this.hosts = sessionHosts(readAgenticosJson(this.plugin.claudeConfigDir()));
    // The list is only as fresh as the last sync (session end, upgrade, or here): ask for one when it is old, at most once a minute.
    if (skillsStale(this.cache) && Date.now() - this.syncAt > 60_000) this.sync();
    this.render();
  }

  // ── actions (every one spawns the runtime; the cache's file event re-renders) ──

  private spawnEnv(): Record<string, string> {
    return { AOS_VAULT: this.plugin.vaultRoot(), AOS_CONFIG: path.join(this.plugin.claudeConfigDir(), "agenticos.json") };
  }

  private sync(): void {
    this.syncAt = Date.now();
    this.plugin.runBrainScript(AOS_CLI, ["skills", "sync"], () => this.schedule(), { env: this.spawnEnv() });
  }

  private setShared(r: SkillRow, share: boolean): void {
    this.plugin.runBrainScript(AOS_CLI, ["skills", share ? "include" : "exclude", r.id], () => this.schedule(), { env: this.spawnEnv() });
  }

  private copy(text: string): void {
    navigator.clipboard.writeText(text).then(() => new Notice(`copied ${text}`), () => new Notice("copy failed"));
  }

  private open(file: string): void {
    try {
      void shell.openPath(file).then((err: string) => { if (err) new Notice(`Cannot open ${file}: ${err}`); });
    } catch { new Notice(`Cannot open ${file}`); }
  }

  // ── render ──

  private render(): void {
    if (!this.view.isTabActive("skills")) return;
    const host = this.host;
    if (!host) return;
    host.empty();
    const { yours, listed } = groupSkills(this.cache.skills);
    const n = skillCounts(yours);

    const head = host.createDiv({ cls: "aos-rt-head" });
    head.createSpan({ cls: "aos-rt-title", text: "Skills" });
    head.createSpan({ cls: "aos-dim aos-rt-count", text: `${n.both} on both · ${n.claude} Claude Code only · ${n.codex} Codex only · ${listed.length} from plugins` });
    const actions = head.createDiv({ cls: "aos-rt-actions" });
    const syncBtn = actions.createEl("button", { cls: "aos-ws-action", text: "sync now", attr: { "data-tour": "skills-sync" } });
    syncBtn.setAttr("title", "aos skills sync: share each host's skills with the other and refresh this list");
    syncBtn.addEventListener("click", () => this.sync());

    const at = asOf(this.cache);
    const state = this.cache.sync.on
      ? `sharing on — each host's skills are copied into the other at the end of every session${at ? ` · as of ${formatAgo(at)}` : ""}`
      : this.cache.scannedAt ? `sharing off — ${this.cache.sync.reason ?? "see aos skills"}` : "not scanned yet — sync now builds the list";
    host.createDiv({ cls: "aos-rt-note aos-dim", text: state });

    const search = host.createEl("input", { cls: "aos-sk-filter", attr: { type: "search", placeholder: "filter skills…", "aria-label": "Filter skills" } });
    search.value = this.query;
    search.addEventListener("input", () => { this.query = search.value; this.renderList(); });

    this.listHost = host.createDiv({ cls: "aos-sk-list" });
    this.renderList();
  }

  private renderList(): void {
    const box = this.listHost;
    if (!box) return;
    box.empty();
    const { yours, listed } = groupSkills(this.cache.skills);
    const mine = filterSkills(yours, this.query);
    const theirs = filterSkills(listed, this.query);

    box.createDiv({ cls: "aos-rt-subhead aos-dim", text: `YOUR SKILLS (${mine.length})` });
    const t1 = box.createDiv({ cls: "aos-inv-table aos-sk-table" });
    if (!mine.length) t1.createDiv({ cls: "aos-inv-row aos-dim", text: this.query ? "no match" : "none yet — a skill is a folder with a SKILL.md in either host's skills folder" });
    for (const r of mine) this.renderRow(t1, r, true);

    box.createDiv({ cls: "aos-rt-subhead aos-dim", text: `PLUGINS & BUILT-INS (${theirs.length}) — listed, not copied: they need their plugin's tools` });
    const t2 = box.createDiv({ cls: "aos-inv-table aos-sk-table" });
    if (!theirs.length) t2.createDiv({ cls: "aos-inv-row aos-dim", text: this.query ? "no match" : "none" });
    for (const r of theirs) this.renderRow(t2, r, false);
  }

  private renderRow(table: HTMLElement, r: SkillRow, yours: boolean): void {
    const chip = statusChip(r);
    const el = table.createDiv({ cls: `aos-inv-row aos-sk-row${r.status === "excluded" ? " is-off" : ""}` });
    const name = el.createDiv({ cls: "aos-sk-name" });
    name.createDiv({ text: r.name });
    name.createDiv({ cls: "aos-dim aos-sk-desc", text: r.description, attr: { title: r.description } });

    const pills = el.createDiv({ cls: "aos-sk-pills" });
    for (const h of SKILL_HOSTS) {
      const side = r.on[h];
      const cls = side ? (h === "claude" ? "aos-pill-cyan" : "aos-pill-amber") : "aos-pill-dim is-absent";
      pills.createSpan({ cls: `aos-pill ${cls}`, text: h, attr: { title: side ? `${HOST_LABEL[h]}: ${side.invoke}${side.via === "mirror" ? " (a translated copy)" : ""}` : `not in ${HOST_LABEL[h]}` } });
    }
    el.createSpan({ cls: "aos-pill aos-pill-dim aos-sk-source", text: sourceLabel(r), attr: { title: r.origin.path } });
    el.createSpan({ cls: `aos-pulse-chip ${chip.cls}`, text: chip.text, attr: { title: r.note ?? "" } });

    const acts = el.createDiv({ cls: "aos-rt-rowactions aos-sk-actions" });
    for (const h of this.hosts) {
      const cmd = runCommand(r, h);
      if (!cmd) continue;
      const run = acts.createEl("a", { text: `❯_ ${h}`, cls: "aos-link", href: "#", attr: { title: `run in a new ${HOST_LABEL[h]} session: ${cmd}` } });
      run.addEventListener("click", (e) => { e.preventDefault(); this.view.runInTerm(cmd, { host: h, origin: "Skills" }); });
    }
    const first = this.hosts.map((h) => r.on[h]).find(Boolean) ?? r.on.claude ?? r.on.codex;
    if (first) {
      const cp = acts.createEl("a", { text: "⧉", cls: "aos-link", href: "#", attr: { title: `copy ${first.invoke}`, "aria-label": "copy invocation" } });
      cp.addEventListener("click", (e) => { e.preventDefault(); this.copy(first.invoke); });
    }
    if (r.origin.path) {
      const op = acts.createEl("a", { text: "open", cls: "aos-link", href: "#", attr: { title: r.origin.path } });
      op.addEventListener("click", (e) => { e.preventDefault(); this.open(r.origin.path); });
    }
    if (yours && this.cache.sync.on && SHAREABLE.has(r.status)) {
      const share = r.status === "excluded";
      const tg = acts.createEl("a", { text: share ? "share" : "unshare", cls: "aos-link", href: "#", attr: { title: share ? "copy it into the other host again" : "stop copying it into the other host (its copy there is removed)" } });
      tg.addEventListener("click", (e) => { e.preventDefault(); this.setShared(r, share); });
    }
  }
}
