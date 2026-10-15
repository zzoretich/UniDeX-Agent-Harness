import { Notice } from "obsidian";
import type { TAbstractFile } from "obsidian";
import * as path from "path";
import type AgenticOSPlugin from "../../main";
import type { WorkbenchView } from "./WorkbenchView";
import { readAgenticosJson, sessionHosts, SessionHost } from "../data/aosConfig";
import {
  AgentsCache, AgentRow, AGENTS_PATH, AGENT_HOSTS, emptyAgents, readAgents, agentsStale, groupAgents, filterAgents,
  agentCounts, sourceLabel, statusChip, runCommand, asOf,
} from "../data/agents";
import { formatAgo } from "./RoutinesTab";
import { shell } from "../host";

const AOS_CLI = "brain/scripts/cli/aos.js";
const HOST_LABEL: Record<SessionHost, string> = { claude: "Claude Code", codex: "Codex" };
const SHAREABLE = new Set(["universal", "pending", "excluded"]);
const RUN_TITLE: Record<SessionHost, string> = {
  claude: "start a Claude Code session as this agent",
  codex: "start a Codex session that asks for the task, then spawns this agent",
};

/**
 * AGENTS — every Claude Code and Codex agent from brain/_index/agents.json (spec 2026-09-23-universal-agents D7), written
 * by the runtime's `aos agents sync`, which also mirrors each host's user agents into the other host's agents folder,
 * translated between Markdown and TOML. Two sections: your agents (shared across hosts) and plugin agents and Codex
 * config.toml roles (listed only). A row starts its agent in a fresh Term session on either host, copies how to reach it,
 * opens its file, and shares or unshares it. The tab never writes an agent itself: every action spawns the runtime, and
 * the cache's file event re-renders. Logic lives in src/data/agents.ts; this class only renders and wires.
 */
export class AgentsTab {
  private host: HTMLElement | null = null;
  private listHost: HTMLElement | null = null;
  private cache: AgentsCache = emptyAgents();
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
      const watch = (f: TAbstractFile) => { if (f.path === AGENTS_PATH) this.schedule(); };
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
    this.cache = readAgents(this.plugin.vaultRoot());
    this.hosts = sessionHosts(readAgenticosJson(this.plugin.claudeConfigDir()));
    // The list is only as fresh as the last sync (session end, upgrade, or here): ask for one when it is old, at most once a minute.
    if (agentsStale(this.cache) && Date.now() - this.syncAt > 60_000) this.sync();
    this.render();
  }

  // ── actions (every one spawns the runtime; the cache's file event re-renders) ──

  private spawnEnv(): Record<string, string> {
    return { AOS_VAULT: this.plugin.vaultRoot(), AOS_CONFIG: path.join(this.plugin.claudeConfigDir(), "agenticos.json") };
  }

  private sync(): void {
    this.syncAt = Date.now();
    this.plugin.runBrainScript(AOS_CLI, ["agents", "sync"], () => this.schedule(), { env: this.spawnEnv() });
  }

  private setShared(r: AgentRow, share: boolean): void {
    this.plugin.runBrainScript(AOS_CLI, ["agents", share ? "include" : "exclude", r.id], () => this.schedule(), { env: this.spawnEnv() });
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
    if (!this.view.isTabActive("agents")) return;
    const host = this.host;
    if (!host) return;
    host.empty();
    const { yours, listed } = groupAgents(this.cache.agents);
    const n = agentCounts(yours);

    const head = host.createDiv({ cls: "aos-rt-head" });
    head.createSpan({ cls: "aos-rt-title", text: "Agents" });
    head.createSpan({ cls: "aos-dim aos-rt-count", text: `${n.both} on both · ${n.claude} Claude Code only · ${n.codex} Codex only · ${listed.length} from plugins and config.toml` });
    const actions = head.createDiv({ cls: "aos-rt-actions" });
    const syncBtn = actions.createEl("button", { cls: "aos-ws-action", text: "sync now", attr: { "data-tour": "agents-sync" } });
    syncBtn.setAttr("title", "aos agents sync: share each host's agents with the other and refresh this list");
    syncBtn.addEventListener("click", () => this.sync());

    const at = asOf(this.cache);
    const state = this.cache.sync.on
      ? `sharing on — each host's agents are copied into the other at the end of every session${at ? ` · as of ${formatAgo(at)}` : ""}`
      : this.cache.scannedAt ? `sharing off — ${this.cache.sync.reason ?? "see aos agents"}` : "not scanned yet — sync now builds the list";
    host.createDiv({ cls: "aos-rt-note aos-dim", text: state, attr: { "data-tour": "agents-sharing" } });
    if (!this.cache.codexAgents.on && this.hosts.includes("codex")) {
      host.createDiv({ cls: "aos-rt-note aos-ag-warn", text: `${this.cache.codexAgents.reason ?? "Codex subagents are off"} — Codex will not spawn these agents until it is on` });
    }
    host.createDiv({ cls: "aos-rt-note aos-dim", text: "Claude Code: ask for an agent by name or mention @agent-<name>. Codex: ask for it by name and Codex spawns it.", attr: { "data-tour": "agents-reach" } });

    const search = host.createEl("input", { cls: "aos-sk-filter", attr: { type: "search", placeholder: "filter agents…", "aria-label": "Filter agents" } });
    search.value = this.query;
    search.addEventListener("input", () => { this.query = search.value; this.renderList(); });

    this.listHost = host.createDiv({ cls: "aos-sk-list" });
    this.renderList();
  }

  private renderList(): void {
    const box = this.listHost;
    if (!box) return;
    box.empty();
    const { yours, listed } = groupAgents(this.cache.agents);
    const mine = filterAgents(yours, this.query);
    const theirs = filterAgents(listed, this.query);

    box.createDiv({ cls: "aos-rt-subhead aos-dim", text: `YOUR AGENTS (${mine.length})` });
    const t1 = box.createDiv({ cls: "aos-inv-table aos-sk-table" });
    if (!mine.length) t1.createDiv({ cls: "aos-inv-row aos-dim", text: this.query ? "no match" : "none yet — an agent is a .md file in Claude Code's agents folder or a .toml file in Codex's" });
    for (const r of mine) this.renderRow(t1, r, true);

    box.createDiv({ cls: "aos-rt-subhead aos-dim", text: `PLUGINS & CONFIG.TOML (${theirs.length}) — listed, not copied` });
    const t2 = box.createDiv({ cls: "aos-inv-table aos-sk-table" });
    if (!theirs.length) t2.createDiv({ cls: "aos-inv-row aos-dim", text: this.query ? "no match" : "none" });
    for (const r of theirs) this.renderRow(t2, r, false);
  }

  private renderRow(table: HTMLElement, r: AgentRow, yours: boolean): void {
    const chip = statusChip(r);
    const el = table.createDiv({ cls: `aos-inv-row aos-sk-row${r.status === "excluded" ? " is-off" : ""}` });
    const name = el.createDiv({ cls: "aos-sk-name" });
    const title = name.createDiv({ text: r.name });
    if (r.readOnly) title.createSpan({ cls: "aos-pill aos-pill-dim aos-ag-ro", text: "read-only", attr: { title: "its tools cannot write: read-only on both hosts" } });
    name.createDiv({ cls: "aos-dim aos-sk-desc", text: r.description, attr: { title: r.description } });

    const pills = el.createDiv({ cls: "aos-sk-pills" });
    for (const h of AGENT_HOSTS) {
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
      const run = acts.createEl("a", { text: `❯_ ${h}`, cls: "aos-link", href: "#", attr: { title: `${RUN_TITLE[h]}: ${cmd}` } });
      run.addEventListener("click", (e) => { e.preventDefault(); this.view.runInTerm(cmd, { host: h, origin: "Agents" }); });
    }
    const first = this.hosts.map((h) => r.on[h]).find(Boolean) ?? r.on.claude ?? r.on.codex;
    if (first) {
      const cp = acts.createEl("a", { text: "⧉", cls: "aos-link", href: "#", attr: { title: `copy ${first.invoke}`, "aria-label": "copy how to reach the agent" } });
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
