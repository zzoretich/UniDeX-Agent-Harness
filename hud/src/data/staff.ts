import { App } from "obsidian";
import * as path from "path";
import { parseFrontmatter, firstLine } from "./frontmatter";
import { fs } from "../host";

export interface StaffAgent {
  name: string;
  color?: string | null;
  description?: string | null;
  heartbeat: {
    status?: string;
    started_at?: string;
    completed_at?: string;
    errored_at?: string;
    duration_sec?: number;
    trigger?: string;
    last_brief?: string;
    next_fire?: string;
    summary?: string;
    [k: string]: unknown;
  } | null;
  heartbeatMtime: number;
}

function vaultBase(app: App): string | null {
  const adapter = app.vault.adapter as unknown as { getBasePath?: () => string };
  return adapter.getBasePath ? adapter.getBasePath() : null;
}

function readSubAgentsFromFs(vault: string): StaffAgent[] {
  const subAgentsDir = path.join(vault, "brain/agents");
  const agentsDir = path.join(vault, "agents");
  if (!fs.existsSync(subAgentsDir)) return [];
  const out: StaffAgent[] = [];
  for (const d of fs.readdirSync(subAgentsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const hbPath = path.join(subAgentsDir, d.name, "heartbeat.json");
    if (!fs.existsSync(hbPath)) continue;
    let heartbeat: StaffAgent["heartbeat"] = null;
    try { heartbeat = JSON.parse(fs.readFileSync(hbPath, "utf8")); } catch { /* skip corrupt */ }
    if (!heartbeat) continue;

    let color: string | null = null;
    let description: string | null = null;
    const personaPath = path.join(agentsDir, `${d.name}.md`);
    if (fs.existsSync(personaPath)) {
      try {
        const fm = parseFrontmatter(fs.readFileSync(personaPath, "utf8"));
        color = (fm.color as string) || null;
        description = firstLine(fm.description) || null;
      } catch { /* skip */ }
    }

    const stat = fs.statSync(hbPath);
    out.push({
      name: d.name,
      color,
      description,
      heartbeat,
      heartbeatMtime: stat.mtimeMs,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadStaff(app: App): Promise<StaffAgent[]> {
  const vault = vaultBase(app);
  if (!vault) return [];
  try { return readSubAgentsFromFs(vault); }
  catch (e) { console.warn("[agentic-os] staff load failed:", e); return []; }
}
