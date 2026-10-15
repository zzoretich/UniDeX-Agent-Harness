'use strict';
const { nowIso } = require('./util');

const SYSTEM = 'You are a terse project analyst. Given a workspace summary, reply with EXACTLY two lines and nothing else:\nINSIGHT: <2-3 sentences on momentum, risk, or what is stuck>\nNEXT: <one short next action, or NONE if a next step is already set>';

function buildPrompt(entry) {
  const objectives = (entry.objectives || []).map((o) => `- ${o.text}`).join('\n') || '(none)';
  const subs = (entry.subprojects || []).map((s) => `${s.name}${s.status ? ` (${s.status})` : ''}`).join(', ') || '(none)';
  const age = entry.lastEvent && entry.lastEvent.ageDays != null ? `${entry.lastEvent.ageDays}d ago` : 'unknown';
  const nextSet = entry.next && entry.next.text ? entry.next.text : 'NONE';
  return [
    `Workspace: ${entry.name}`,
    `Status: ${entry.status || 'unknown'}`,
    `Summary: ${entry.summary || '(none)'}`,
    `Last activity: ${age}`,
    `Objectives:\n${objectives}`,
    `Subprojects: ${subs}`,
    `Existing next step: ${nextSet}`,
  ].join('\n');
}

function parseInsightReply(text) {
  const out = { insight: null, next: null };
  if (!text) return out;
  const im = text.match(/INSIGHT:\s*([\s\S]*?)(?:\nNEXT:|$)/i);
  const nm = text.match(/NEXT:\s*(.*)$/im);
  if (im) out.insight = im[1].trim() || null;
  if (nm) {
    const v = nm[1].trim();
    out.next = (!v || /^none$/i.test(v)) ? null : v;
  }
  return out;
}

function heuristicInsight(entry) {
  const { insightHeuristic } = require('../lib/heuristics.js');
  return {
    insight: { text: insightHeuristic(entry), status: 'ok', model: 'heuristic', generatedAt: nowIso(), inputHash: entry.inputHash, next: null },
  };
}

// generateInsight(entry, { chatFn, model, provider, numPredict }) -> { insight }
// The model's NEXT stays on the insight (insight.next, a suggestion shown as such) and never becomes the workspace's
// own next step: entry.next names its source or stays empty (spaces-redesign D23).
// chatFn injected → used as-is (tests). Otherwise the provider decides:
//   ollama → chat; claude → chat only when scan.insightsUnderClaude; codex → only when scan.insightsUnderCodex; none → heuristic.
// Under provider local, none is also the local engine down (local-first A3), and the local engine failing mid-call
// falls back to the heuristic too.
async function generateInsight(entry, opts = {}) {
  let chatFn = opts.chatFn;
  let model = opts.model;
  let localEngine = false;
  if (!chatFn) {
    const p = opts.provider || await require('../sdk/lib/provider.js').getProvider('workspace-insights');
    const cfg = require('../lib/config.js').loadConfig();
    const useModel = p.name === 'ollama' || (p.name === 'claude' && cfg.scan.insightsUnderClaude === true)
      || (p.name === 'codex' && cfg.scan.insightsUnderCodex === true);
    if (!useModel) return heuristicInsight(entry);
    chatFn = (o) => p.chat({ ...o, feature: 'workspace-insights' });
    localEngine = !!p.engine;
    model = model || (p.name === 'claude' ? cfg.claude.model : p.name === 'codex' ? (p.model || 'codex-default') : p.model || require('../sdk/lib/models.js').role('workhorse').tag);
  }
  model = model || require('../sdk/lib/models.js').role('workhorse').tag;
  try {
    const reply = await chatFn({
      system: SYSTEM, prompt: buildPrompt(entry), model,
      numPredict: opts.numPredict || 200, timeoutMs: 60000,
    });
    const parsed = parseInsightReply(reply);
    const insight = {
      text: parsed.insight, status: parsed.insight ? 'ok' : 'unavailable',
      model, generatedAt: nowIso(), inputHash: entry.inputHash, next: parsed.next,
    };
    return { insight };
  } catch {
    if (localEngine) return heuristicInsight(entry);
    return { insight: { text: null, status: 'unavailable', model, generatedAt: nowIso(), inputHash: entry.inputHash, next: null } };
  }
}

module.exports = { buildPrompt, parseInsightReply, generateInsight, heuristicInsight, SYSTEM };
