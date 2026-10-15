/**
 * Aggregates health signals from all other collectors into a unified severity-tagged list.
 * Severity: error (broken refs, missing files), warn (bloat, drift), info (notices).
 */
const path = require('path');
const { PATHS } = require('../lib/paths.js');
const { readFrontmatter } = require('./util.js');

// BRAIN.md + the 3 MOCs carry a build-brain-md.js freshness contract
// (generatedAt/ttl in frontmatter). "Nh"/"Nd" only.
const CONTRACT_FILES = [
  { name: 'BRAIN.md', rel: 'brain/_index/BRAIN.md' },
  { name: 'MOC-reference.md', rel: 'brain/_index/MOC-reference.md' },
  { name: 'MOC-projects.md', rel: 'brain/_index/MOC-projects.md' },
  { name: 'MOC-patterns.md', rel: 'brain/_index/MOC-patterns.md' },
];

function parseTtlMs(ttl) {
  const m = String(ttl || '').match(/^(\d+)([hd])$/);
  if (!m) return null;
  return Number(m[1]) * (m[2] === 'h' ? 3600000 : 86400000);
}

function collectHealth(snapshot) {
  const issues = [];
  const add = (severity, area, message, detail) => issues.push({ severity, area, message, detail: detail ?? null });

  const cfg = snapshot.config;
  const cap = snapshot.capabilities;
  const br = snapshot.brain;
  const pj = snapshot.projects;
  const pl = snapshot.plans;
  const rt = snapshot.runtime;
  const gsd = snapshot.gsd;

  // Config integrity. CLAUDE.md is Claude Code's instruction file: on a Codex-only install (agenticos.json
  // hosts.claude.enabled === false) its absence is expected, not an error.
  const claudeHost = (() => { try { const h = require('../lib/config.js').loadConfig().hosts; return !h || !h.claude || h.claude.enabled !== false; } catch { return true; } })();
  if (claudeHost && cfg.claudeMd?.missing) add('error', 'config', 'CLAUDE.md is missing');
  if (cfg.memoryMd?.missing) add('error', 'config', 'MEMORY.md is missing');
  if (cfg.stray?.length) add('warn', 'config', `Stray files: ${cfg.stray.join(', ')}`);

  // Capabilities
  if (cap.hooks.missingRefs?.length) {
    add('error', 'hooks', `${cap.hooks.missingRefs.length} hook references in settings.json point to non-existent files`, cap.hooks.missingRefs);
  }
  if (cap.hooks.orphans?.length) {
    add('warn', 'hooks', `${cap.hooks.orphans.length} hook scripts not wired in settings.json`, cap.hooks.orphans);
  }
  if (cap.skills.missingSkillMd?.length) {
    add('warn', 'skills', `${cap.skills.missingSkillMd.length} skill dirs missing SKILL.md`, cap.skills.missingSkillMd);
  }

  // Brain
  const mi = br?.memoryIndex;
  if (mi?.brokenPointers?.length) {
    add('error', 'brain', `${mi.brokenPointers.length} broken MEMORY.md pointers`, mi.brokenPointers.map(p => `"${p.title}" → ${p.target}`));
  }
  if (mi?.orphanMemories?.length) {
    add('warn', 'brain', `${mi.orphanMemories.length} memory files not indexed in MEMORY.md`, mi.orphanMemories);
  }
  if (mi?.orphanPatterns?.length) {
    add('warn', 'brain', `${mi.orphanPatterns.length} pattern files not indexed in MEMORY.md`, mi.orphanPatterns);
  }
  if (br?.sessions && !br.sessions.todayPresent) {
    add('info', 'brain', `No session log for today (${br.sessions.today})`);
  }

  // Projects & sessions
  if (pj?.staleSessionCount) {
    add('warn', 'sessions', `${pj.staleSessionCount} stale sessions (≥30d without lock — cleanup candidates)`);
  }
  const orphanTotal = (pj?.orphanUuids?.sessionEnv?.length || 0) + (pj?.orphanUuids?.tasks?.length || 0) + (pj?.orphanUuids?.fileHistory?.length || 0);
  if (orphanTotal) {
    add('warn', 'sessions', `${orphanTotal} orphan UUIDs (side-folder present, no JSONL)`, pj.orphanUuids);
  }
  if (pj?.summary?.userNamedWithoutMemory) {
    add('info', 'projects', `${pj.summary.userNamedWithoutMemory} user-named projects without a linked brain memory`);
  }
  // Sessions of either host that ran outside workspaces/ (workspace hub D4): information, never a fault.
  const outside = snapshot.hostSessions?.outsideWorkspaces;
  if (Array.isArray(outside) && outside.length) {
    add('info', 'projects', `${outside.length} session cwd${outside.length === 1 ? '' : 's'} outside workspaces/ (run aos workspace list)`, outside.slice(0, 10).map((o) => o.cwd));
  }

  // Plans
  if (pl?.summary?.dormant) {
    add('warn', 'plans', `${pl.summary.dormant} dormant plans (>30d without edits)`);
  }
  if (pl?.summary?.stale) {
    add('info', 'plans', `${pl.summary.stale} stale plans (7–30d)`);
  }

  // Runtime / bloat
  if (rt?.backups?.warnLarge) {
    add('warn', 'runtime', `Backups are large: ${rt.backups.count} files`);
  }
  if (rt?.downloads?.warnLarge) {
    add('warn', 'runtime', `downloads/ is oversized (>100MB)`);
  }
  if (rt?.shellSnapshots?.warnLarge) {
    add('warn', 'runtime', `shell-snapshots/ has >100 files — cleanup candidate`);
  }
  if (rt?.cache?.files) {
    for (const f of rt.cache.files) {
      if (f.ageDays > 30) add('info', 'runtime', `cache/${f.name} is ${f.ageDays}d old`);
    }
  }

  // The local engine (local-first A3): down under provider local, background work waits and session wraps queue up.
  try {
    const lw = require('../lib/local-down.js').localWaiting({ cfg: require('../lib/config.js').loadConfig(), vault: PATHS.VAULT });
    if (lw.reason) {
      const fix = lw.reason === 'local-down' ? 'start Ollama (or your local engine)' : 'run aos local pull';
      add(lw.queued ? 'error' : 'warn', 'local', `${lw.line[0].toUpperCase()}${lw.line.slice(1)} — ${fix}; they wrap when it is back`, lw.reason);
    }
  } catch { /* a health signal, never a scan failure */ }

  // GSD
  if (gsd?.installed && gsd?.manifest?.present && gsd.manifest.drift) {
    add('error', 'gsd', `GSD manifest drift: ${gsd.manifest.drift} files listed in manifest are missing on disk`, gsd.manifest.missing);
  }

  // Artifacts — build-brain-md.js freshness contracts (BRAIN.md + 3 MOCs)
  for (const { name, rel } of CONTRACT_FILES) {
    const abs = path.join(PATHS.VAULT, rel);
    const fm = readFrontmatter(abs);
    if (!fm.generatedAt || !fm.ttl) {
      add('info', 'artifacts', `${name} is missing its freshness contract keys`, 'regenerate via build-brain-md once P4 has landed it');
      continue;
    }
    const ttlMs = parseTtlMs(fm.ttl);
    const genMs = Date.parse(fm.generatedAt);
    if (ttlMs != null && !Number.isNaN(genMs) && (Date.now() - genMs) > ttlMs) {
      add('warn', 'artifacts', `${name} is past its freshness contract`, 'regenerate via build-brain-md');
    }
  }

  const counts = {
    error: issues.filter(i => i.severity === 'error').length,
    warn: issues.filter(i => i.severity === 'warn').length,
    info: issues.filter(i => i.severity === 'info').length,
  };
  counts.total = issues.length;

  return { issues, counts };
}

function renderHealthMarkdown(snapshot, health) {
  const lines = [];
  lines.push('---');
  lines.push('type: health-report');
  lines.push(`scanned: ${snapshot.scannedAt}`);
  lines.push(`errors: ${health.counts.error}`);
  lines.push(`warnings: ${health.counts.warn}`);
  lines.push('tags: [health, drift, dashboard]');
  lines.push('---');
  lines.push('');
  lines.push('# Health & Drift Report');
  lines.push('');
  lines.push(`> Generated ${snapshot.scannedAt}. ${health.counts.total} issues (${health.counts.error} errors, ${health.counts.warn} warnings, ${health.counts.info} info).`);
  lines.push('');
  if (health.counts.total === 0) {
    lines.push('**All systems clean.** No health issues detected.');
    lines.push('');
    return lines.join('\n');
  }
  for (const sev of ['error', 'warn', 'info']) {
    const group = health.issues.filter(i => i.severity === sev);
    if (!group.length) continue;
    lines.push(`## ${sev.toUpperCase()} (${group.length})`);
    lines.push('');
    for (const iss of group) {
      lines.push(`- **[${iss.area}]** ${iss.message}`);
      if (iss.detail) {
        if (Array.isArray(iss.detail)) {
          for (const d of iss.detail.slice(0, 25)) lines.push(`  - \`${d}\``);
          if (iss.detail.length > 25) lines.push(`  - … +${iss.detail.length - 25} more`);
        } else if (typeof iss.detail === 'object') {
          for (const [k, v] of Object.entries(iss.detail)) {
            if (Array.isArray(v) && v.length) lines.push(`  - ${k}: ${v.slice(0, 5).map(x => `\`${String(x).slice(0, 8)}\``).join(', ')}${v.length > 5 ? ` +${v.length - 5}` : ''}`);
          }
        }
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = { collectHealth, renderHealthMarkdown };
