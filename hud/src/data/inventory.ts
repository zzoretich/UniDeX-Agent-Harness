import { App } from "obsidian";
import * as path from "path";
import { parseFrontmatter, firstLine, asStringList } from "./frontmatter";
import { fs, type HostStats } from "../host";

export interface InventoryAgent {
  name: string;
  file?: string;
  path?: string;
  description?: string;
  model?: string;
  color?: string;
  tools?: string[];
  toolCount?: number;
  bytes?: number;
  mtime?: number;
  gsd?: boolean;
  [k: string]: unknown;
}

export interface InventorySkill {
  name: string;
  dir?: string;
  path?: string;
  description?: string;
  argumentHint?: string;
  allowedTools?: string[];
  toolCount?: number;
  bytes?: number;
  mtime?: number;
  missingSkillMd?: boolean;
  gsd?: boolean;
  [k: string]: unknown;
}

export interface InventoryData {
  scannedAt: string;
  agents: InventoryAgent[];
  skills: InventorySkill[];
  counts: {
    agents: number;
    agentsGsd: number;
    skills: number;
    skillsGsd: number;
    skillsMissingMd: number;
  };
}

function vaultBase(app: App): string | null {
  const adapter = app.vault.adapter as unknown as { getBasePath?: () => string };
  return adapter.getBasePath ? adapter.getBasePath() : null;
}

function readAgentsFromFs(vault: string): InventoryAgent[] {
  const dir = path.join(vault, "agents");
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out: InventoryAgent[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const abs = path.join(dir, name);
    let txt: string, stat: HostStats;
    try { txt = fs.readFileSync(abs, "utf8"); stat = fs.statSync(abs); } catch { continue; }
    const fm = parseFrontmatter(txt);
    const base = name.replace(/\.md$/, "");
    const tools = asStringList(fm.tools);
    out.push({
      name: (fm.name as string) || base,
      file: name,
      path: `agents/${name}`,
      description: firstLine(fm.description),
      model: (fm.model as string) || "",
      color: (fm.color as string) || "",
      tools,
      toolCount: tools.length,
      bytes: stat.size,
      mtime: stat.mtimeMs,
      gsd: base.startsWith("gsd-") || base.startsWith("gsd_"),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function readSkillsFromFs(vault: string): InventorySkill[] {
  const dir = path.join(vault, "skills");
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(dir); } catch { return []; }
  const out: InventorySkill[] = [];
  for (const d of dirs) {
    const dirAbs = path.join(dir, d);
    let dstat: HostStats;
    try { dstat = fs.statSync(dirAbs); } catch { continue; }
    if (!dstat.isDirectory()) continue;
    const skillMd = path.join(dirAbs, "SKILL.md");
    let txt = "", stat: HostStats = { size: 0, mtimeMs: dstat.mtimeMs } as HostStats, missing = false;
    try { txt = fs.readFileSync(skillMd, "utf8"); stat = fs.statSync(skillMd); }
    catch { missing = true; }
    const fm = parseFrontmatter(txt);
    const allowedTools = asStringList(fm["allowed-tools"]);
    out.push({
      name: (fm.name as string) || d,
      dir: d,
      path: `skills/${d}`,
      description: firstLine(fm.description),
      argumentHint: (fm["argument-hint"] as string) || "",
      allowedTools,
      toolCount: allowedTools.length,
      bytes: stat.size,
      mtime: stat.mtimeMs,
      missingSkillMd: missing,
      gsd: d.startsWith("gsd-") || d.startsWith("gsd_"),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadInventory(app: App): Promise<InventoryData | null> {
  const vault = vaultBase(app);
  if (!vault) return null;
  try {
    const agents = readAgentsFromFs(vault);
    const skills = readSkillsFromFs(vault);
    return {
      scannedAt: new Date().toISOString(),
      agents,
      skills,
      counts: {
        agents: agents.length,
        agentsGsd: agents.filter((a) => a.gsd).length,
        skills: skills.length,
        skillsGsd: skills.filter((s) => s.gsd).length,
        skillsMissingMd: skills.filter((s) => s.missingSkillMd).length,
      },
    };
  } catch (e) {
    console.warn("[agentic-os] inventory load failed:", e);
    return null;
  }
}
