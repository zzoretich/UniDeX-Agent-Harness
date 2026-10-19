import { App } from "obsidian";
import { Snapshot, DailySnapshot, SNAPSHOT_HISTORY_DIR } from "./snapshot";

export interface DeltaItem {
  label: string;
  before: number;
  after: number;
  diff: number;
  severity: "good" | "bad" | "neutral";
}

export interface SnapshotDelta {
  hasPrevious: boolean;
  previousDate: string | null;
  items: DeltaItem[];
}

const NEUTRAL_KEYS: Set<string> = new Set(["agents", "commands", "skills", "patterns", "sessions"]);
const GOOD_UP_KEYS: Set<string> = new Set(["memories", "reflections", "brainScripts"]);

export async function computeDelta(app: App, snap: Snapshot): Promise<SnapshotDelta> {
  // load latest prior daily snapshot
  try {
    const list = await app.vault.adapter.list(SNAPSHOT_HISTORY_DIR);
    const files = (list.files || []).filter((p) => p.endsWith(".json")).sort();
    const todayKey = new Date().toISOString().slice(0, 10);
    // find the most recent that's NOT today's
    let priorPath: string | null = null;
    for (let i = files.length - 1; i >= 0; i--) {
      const base = files[i].split("/").pop() || "";
      if (base.startsWith(todayKey)) continue;
      priorPath = files[i];
      break;
    }
    if (!priorPath) return { hasPrevious: false, previousDate: null, items: [] };

    const raw = await app.vault.adapter.read(priorPath);
    const prior = JSON.parse(raw) as DailySnapshot;

    const items: DeltaItem[] = [];
    const cur = {
      agents: snap.capabilities.agents.count,
      commands: snap.capabilities.commands.count,
      skills: snap.capabilities.skills.count,
      memories: snap.config.memoryMd?.pointers ?? 0,
      sessions: snap.brain.counts?.sessions ?? 0,
      errors: (snap.health.issues || []).filter(i => i.severity === "error").length,
      warns: (snap.health.issues || []).filter(i => i.severity === "warn").length,
    };
    const pri = {
      agents: prior.counts.agents,
      commands: prior.counts.commands,
      skills: prior.counts.skills,
      memories: prior.counts.memories,
      sessions: prior.counts.sessions,
      errors: prior.health.error,
      warns: prior.health.warn,
    };

    for (const k of ["agents", "commands", "skills", "memories", "sessions"] as const) {
      const before = pri[k];
      const after = cur[k];
      const diff = after - before;
      if (diff === 0) continue;
      let severity: DeltaItem["severity"] = "neutral";
      if (GOOD_UP_KEYS.has(k)) severity = diff > 0 ? "good" : "bad";
      else if (NEUTRAL_KEYS.has(k)) severity = "neutral";
      items.push({ label: k, before, after, diff, severity });
    }
    // health: down is good
    for (const k of ["errors", "warns"] as const) {
      const before = pri[k];
      const after = cur[k];
      const diff = after - before;
      if (diff === 0) continue;
      items.push({ label: k, before, after, diff, severity: diff < 0 ? "good" : "bad" });
    }

    return {
      hasPrevious: true,
      previousDate: prior.date,
      items,
    };
  } catch (err) {
    console.warn("[agentic-os] delta unavailable:", err);
    return { hasPrevious: false, previousDate: null, items: [] };
  }
}
