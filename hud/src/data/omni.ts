// Pure ⌘K item builder — one flat list over everything searchable.
import type { WorkspaceMap } from "./workspaceMaps";
import type { MemoryMeta } from "./memories";

export interface OmniItem {
  kind: "file" | "memory" | "run" | "agent" | "skill" | "action";
  label: string;
  hint: string;
  payload: string;
}
export interface OmniInputs {
  maps: Record<string, WorkspaceMap | null>;
  memories: MemoryMeta[];
  runs: { id: string; label?: string | null }[];
  agents: { name: string }[];
  skills: { name: string; path: string }[];   // from inventory data (spec: "agents/skills")
  actions: { id: string; title: string }[];
}

export function buildOmniItems(i: OmniInputs): OmniItem[] {
  const out: OmniItem[] = [];
  for (const [ws, map] of Object.entries(i.maps)) {
    for (const f of map?.files ?? []) {
      out.push({ kind: "file", label: `${ws}/${f.path}`, hint: f.desc ?? "", payload: `workspaces/${ws}/${f.path}` });
    }
  }
  for (const m of i.memories) out.push({ kind: "memory", label: m.title, hint: `${m.type} · ${m.slug}`, payload: m.path });
  for (const r of i.runs) out.push({ kind: "run", label: r.label || r.id, hint: r.id, payload: r.id });
  for (const a of i.agents) out.push({ kind: "agent", label: a.name, hint: "agent", payload: a.name });
  for (const s of i.skills) out.push({ kind: "skill", label: s.name, hint: "skill", payload: s.path });
  for (const a of i.actions) out.push({ kind: "action", label: a.title, hint: "fix/deck action", payload: a.id });
  return out;
}
