// What a Pulse row's buttons do (spec 2026-10-08-pulse-cockpit-design P4): safe actions act in place through the writers
// and scripts the other tabs already use; decisions jump (their label ends "→") to the review that owns them. Memories
// and feedback drafts jump into the Brain tab, which acts on them (brain-hub D15): Pulse writes no memory.
import { Notice } from "obsidian";
import type AgenticOSPlugin from "../../../main";
import type { WorkbenchView } from "../WorkbenchView";
import type { NeedItem } from "../../data/pulseFacts";
import type { FixAction } from "../../data/fixQueue";
import type { BrainTarget } from "../../data/brainModel";
import { readAgenticosJson, reviewCommand, sessionHosts, type SessionHost } from "../../data/aosConfig";
import { adapterOf as notificationAdapter, setFlags } from "../../data/notificationWriter";
import { adapterOf as todoAdapter, applyTodoEdit } from "../../data/todoWriter";
import { toggleTodo, localDay } from "../../data/todos";

export interface Act { label: string; jump: boolean; primary?: boolean; run: () => void | Promise<void> }

/** What a row needs from the tab: the plugin and view, a refresh, the Fix Queue, and closing the popup before a jump. */
export interface PulseCtx {
  plugin: AgenticOSPlugin;
  view: WorkbenchView;
  refresh: () => void;
  close: () => void;
  queue: () => FixAction[];
  execute: (a: FixAction) => void;
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const dq = (s: string): string => `"${s.replace(/["\\$`]/g, "\\$&")}"`;

/** A command typed into a new Term session for the first enabled host: Claude Code takes the prompt in double quotes,
 *  Codex in single quotes (so `$agenticos:…` is not expanded by the shell). */
export function hostCommand(host: SessionHost, prompt: string): string {
  return host === "codex" ? `codex ${shq(prompt)}` : `claude ${dq(prompt)}`;
}

function term(ctx: PulseCtx, host: SessionHost, command: string): void {
  ctx.close();
  ctx.view.runInTerm(command, { host, origin: "Pulse" });
}

export function openFile(ctx: PulseCtx, path: string): void {
  ctx.close();
  void ctx.plugin.app.workspace.openLinkText(path, "", true);
}

export function openTab(ctx: PulseCtx, id: string): void {
  ctx.close();
  ctx.view.setTab(id);
}

/** Into the Brain tab (rail id "memory") on a mode, Review's queue or a memory in Library (brain-hub D15). Select only. */
export function openBrain(ctx: PulseCtx, target: BrainTarget): void {
  ctx.close();
  if (!ctx.view.open({ tab: "memory", ...target })) ctx.view.setTab("memory");
}

export function runScript(ctx: PulseCtx, script: string, args: string[], what: string): void {
  new Notice(`Running ${what}…`);
  ctx.plugin.runBrainScript(script, args, () => ctx.refresh());
}

export async function markRead(ctx: PulseCtx, ids: string[]): Promise<void> {
  if (!ids.length) return;
  try { await setFlags(notificationAdapter(ctx.plugin.app), ids, "read", true); } catch (e) { new Notice(`Notifications: ${e instanceof Error ? e.message : String(e)}`); }
  ctx.refresh();
}

export async function tickTodo(ctx: PulseCtx, raw: string): Promise<void> {
  try { await applyTodoEdit(todoAdapter(ctx.plugin.app), (x) => toggleTodo(x ?? "", raw, localDay(new Date()))); } catch (e) { new Notice(`To-Do: ${e instanceof Error ? e.message : String(e)}`); }
  ctx.refresh();
}

/** The buttons for one needs-you item, the primary first. */
export function needActions(ctx: PulseCtx, n: NeedItem, opts: { unreadIds?: string[] } = {}): Act[] {
  const host = sessionHosts(readAgenticosJson())[0] || "claude";
  switch (n.kind) {
    case "error":
      return [
        { label: "Details →", jump: true, primary: true, run: () => openFile(ctx, "brain/_index/health.md") },
        { label: "Fix in a session →", jump: true, run: () => term(ctx, host, hostCommand(host, `Fix this AgenticOS health issue (aos doctor and brain/_index/health.md have the detail): ${n.title}`)) },
      ];
    case "proposal":
    case "flag": {
      const rc = reviewCommand(readAgenticosJson());
      return [{ label: "Review →", jump: true, primary: true, run: () => term(ctx, rc.host, rc.command) }];
    }
    case "drafts":
      return [{ label: "Review →", jump: true, primary: true, run: () => openBrain(ctx, { mode: "review", queue: "drafts" }) }];
    case "gate":
      return [{ label: "Open →", jump: true, primary: true, run: () => openTab(ctx, "agent-teams") }];
    case "pipeline": {
      const fix = ctx.queue().find((a) => a.kind === "spawn" && (a.id === `rerun-${n.ref}` || (n.ref === "scan-vault" && a.id === "run-scan")));
      return fix
        ? [{ label: "Run", jump: false, primary: true, run: () => ctx.execute(fix) }]
        : [{ label: "Details →", jump: true, primary: true, run: () => openFile(ctx, "brain/_index/health.md") }];
    }
    case "routine":
      return [
        { label: "Run now", jump: false, primary: true, run: () => runScript(ctx, "brain/scripts/routines/run-routine.js", [n.ref, "--manual"], n.ref) },
        { label: "Open →", jump: true, run: () => openTab(ctx, "routines") },
      ];
    case "overdue":
    case "today":
      return [{ label: "Open →", jump: true, primary: true, run: () => openTab(ctx, "todo") }];
    case "breaking":
      return [
        { label: "Mark read", jump: false, primary: true, run: () => markRead(ctx, [n.ref]) },
        { label: "Open →", jump: true, run: () => openTab(ctx, "notifications") },
      ];
    case "unread":
      return [
        { label: "Mark read", jump: false, primary: true, run: () => markRead(ctx, opts.unreadIds ?? []) },
        { label: "Open →", jump: true, run: () => openTab(ctx, "notifications") },
      ];
    case "review":
      return [{ label: "Review →", jump: true, primary: true, run: () => openBrain(ctx, { mode: "review", queue: "session" }) }];
    default:
      return [];
  }
}
