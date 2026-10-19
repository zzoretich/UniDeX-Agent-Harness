import { App } from "obsidian";
import * as path from "path";
import { AgentRun } from "./runs";
import { fs } from "../host";

export interface RunEvent {
  type: string;
  ts: number;
  subtype?: string;
  tools?: Array<{ id: string; name: string; input_summary?: string }>;
  results?: Array<{ tool_use_id: string; output_summary?: string; is_error?: boolean }>;
  [k: string]: unknown;
}

export interface RunDetail {
  id: string;
  summary: AgentRun;
  events: RunEvent[];
}

function vaultBase(app: App): string | null {
  const adapter = app.vault.adapter as unknown as { getBasePath?: () => string };
  return adapter.getBasePath ? adapter.getBasePath() : null;
}

function readRunDetailFromFs(vault: string, id: string): RunDetail | null {
  const baseDir = path.join(vault, "brain/_index/agent-runs");
  if (!fs.existsSync(baseDir)) return null;
  // Per-day folders are YYYY-MM-DD; scan newest first (most lookups hit recent runs).
  const days = fs.readdirSync(baseDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
    .map((d) => d.name)
    .sort()
    .reverse();
  for (const day of days) {
    const candidate = path.join(baseDir, day, `${id}.json`);
    if (fs.existsSync(candidate)) {
      try { return JSON.parse(fs.readFileSync(candidate, "utf8")) as RunDetail; }
      catch { return null; }
    }
  }
  // Also peek at live/ in case the run is still in flight.
  const liveDir = path.join(baseDir, "live");
  if (fs.existsSync(liveDir)) {
    const liveFile = fs.readdirSync(liveDir).find((f) => f.includes(id));
    if (liveFile) {
      try {
        const lines = fs.readFileSync(path.join(liveDir, liveFile), "utf8").split(/\r?\n/).filter(Boolean);
        const events: RunEvent[] = [];
        let summary: AgentRun | null = null;
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.type === "run_start") summary = obj as unknown as AgentRun;
            else events.push(obj as RunEvent);
          } catch { /* skip malformed line */ }
        }
        if (summary) return { id, summary, events };
      } catch { /* ignore */ }
    }
  }
  return null;
}

export async function loadRunDetail(app: App, id: string): Promise<RunDetail | null> {
  const vault = vaultBase(app);
  if (!vault) return null;
  return readRunDetailFromFs(vault, id);
}

export function formatEventLabel(e: RunEvent): string {
  if (e.type === "tool_use_batch") {
    const tools = e.tools || [];
    const names = tools.slice(0, 3).map((t) => t.name).join(", ");
    return `tool_use(${tools.length}) · ${names}`;
  }
  if (e.type === "tool_result_batch") {
    const results = e.results || [];
    const errs = results.filter((r) => r.is_error).length;
    return `tool_result(${results.length})${errs ? ` · ${errs} err` : ""}`;
  }
  if (e.type === "system") return `system${e.subtype ? `:${e.subtype}` : ""}`;
  return e.type;
}
