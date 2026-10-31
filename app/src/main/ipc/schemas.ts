// The runtime check of every argument the page sends (main only). Each schema is typed against the contract in
// ../../shared/ipc.ts, so the compiler fails when a type and its schema drift apart. Sizes are generous for what the
// HUD sends and small enough that one call cannot exhaust main.

import { z } from "zod";
import type { ExecRequest, ImportRunRequest, InstallRequest, PersonaAnswers, PtySpawnRequest, ReadyInfo, SessionSendRequest, SessionStartRequest, SetupFixId, SpawnRequest, ThemeSource, WriteVia } from "../../shared/ipc";

const MB = 1024 * 1024;

/** An absolute path: no NUL, at most 4096 bytes. */
export const AbsPath = z.string().min(1).max(4096).refine((p) => p.startsWith("/") && !p.includes("\0"), "an absolute path");

/** A child's or a terminal's name, chosen by the page. */
const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

/** An argument or a variable's value: text without NUL. */
const Text = (max: number) => z.string().max(max).refine((s) => !s.includes("\0"), "no NUL");

const EnvSet = z.record(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/), Text(4096)).refine((r) => Object.keys(r).length <= 32, "at most 32 variables");

const Signal = z.enum(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"]);

export const PathArgs = z.object({ p: AbsPath });
export const RangeArgs = z.object({ p: AbsPath, position: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), length: z.number().int().min(0).max(16 * MB) });
export const WriteArgs = z.object({ p: AbsPath, data: z.string().max(64 * MB), via: z.enum(["hud", "editor"]) satisfies z.ZodType<WriteVia> });
export const AppendArgs = z.object({ p: AbsPath, data: z.string().max(64 * MB) });
export const FolderArgs = z.object({ p: AbsPath, recursive: z.boolean() });
export const TwoPathArgs = z.object({ from: AbsPath, to: AbsPath });
export const NoArgs = z.object({}).strict();
/** An instruction proposal decision names only a vault proposal and the digest reviewed by the user. */
export const ProposalNameArgs = z.object({ name: z.string().regex(/^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{0,60}\.md$/) }).strict();
export const ProposalDecisionArgs = ProposalNameArgs.extend({ digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), token: z.string().regex(/^[a-f0-9]{32}$/) }).strict();
export const ProposalUndoArgs = z.object({ undoId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}-\d{4}-\d{2}-\d{2}T[0-9-]+Z$/) }).strict();
/** The theme choice: one of the three, nothing else. */
export const ThemeSetArgs = z.object({ source: z.enum(["system", "light", "dark"]) satisfies z.ZodType<ThemeSource> }).strict();

export const SpawnRequestSchema: z.ZodType<SpawnRequest> = z.object({
  id: Id,
  cmd: Text(4096).refine((s) => s.length > 0, "a program"),
  args: z.array(Text(512 * 1024)).max(256),
  cwd: AbsPath.optional(),
  env: EnvSet.optional(),
  unsetEnv: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/)).max(8).optional(),
  stdio: z.enum(["pipe", "ignore"]).optional(),
  detached: z.boolean().optional(),
});

export const KillArgs = z.object({ id: Id, signal: Signal.optional() });

export const ExecRequestSchema: z.ZodType<ExecRequest> = z.object({
  file: Text(4096).refine((s) => s.length > 0, "a program"),
  args: z.array(Text(4096)).max(16),
  timeoutMs: z.number().int().min(1).max(60_000),
});

export const PtySpawnRequestSchema: z.ZodType<PtySpawnRequest> = z.object({
  id: Id,
  file: AbsPath,
  args: z.array(Text(4096)).max(16),
  cwd: AbsPath,
  name: z.string().regex(/^[a-z0-9-]{1,32}$/),
  cols: z.number().int().min(1).max(2000),
  rows: z.number().int().min(1).max(1000),
  env: EnvSet.optional(),
});

export const PtyWriteArgs = z.object({ id: Id, data: z.string().max(MB) });
export const PtyResizeArgs = z.object({ id: Id, cols: z.number().int().min(1).max(2000), rows: z.number().int().min(1).max(1000) });

export const UrlArgs = z.object({ url: z.string().max(8192) });

const PluginId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const PluginLoadArgs = z.object({ id: PluginId });
export const PluginSaveArgs = z.object({ id: PluginId, json: z.string().max(4 * MB) });

export const ReadyInfoSchema: z.ZodType<ReadyInfo> = z.object({
  commands: z.array(z.object({
    id: z.string().min(1).max(119),
    name: z.string().max(199),
    hotkeys: z.array(z.object({ modifiers: z.array(z.string().max(16)).max(4), key: z.string().max(32) })).max(8).optional(),
  })).max(500),
});

// ── setup (phase 5) ──────────────────────────────────────────────────

const FIX_IDS = ["node", "uv", "ollama", "ollama-models", "claude", "codex", "claude-login", "codex-login"] as const satisfies readonly SetupFixId[];

const Cols = z.number().int().min(1).max(2000);
const Rows = z.number().int().min(1).max(1000);

export const FixArgs = z.object({ id: z.enum(FIX_IDS), cols: Cols, rows: Rows });
export const SetupInputArgs = z.object({ data: z.string().max(64 * 1024) });
export const SetupResizeArgs = z.object({ cols: Cols, rows: Rows });

/** A model name as the CLIs take it (haiku, claude-sonnet-4-5, opus[1m], gpt-5.1-codex); blank for the default. */
const Model = z.string().trim().max(80).regex(/^[A-Za-z0-9._:/[\]-]*$/);

/** brain/scripts/persona/interview.js normalizeAnswers' rules, checked before `aos init` sees them. */
export const PersonaSchema: z.ZodType<PersonaAnswers> = z.object({
  name: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9 _-]{1,39}$/),
  addressAs: Text(200),
  voice: Text(200),
  priorities: z.array(Text(200)).max(20),
  dutyModel: Model,
  dutyCodexModel: Model,
  dutyEffort: z.enum(["low", "medium", "high"]),
  schedule: z.boolean(),
});

export const InstallRequestSchema: z.ZodType<InstallRequest> = z.object({
  /** none: no agent CLI yet (install-import B2). */
  host: z.enum(["claude", "codex", "both", "none"]),
  vault: Text(4096).refine((s) => s.trim().length > 0, "a folder"),
  persona: PersonaSchema.nullable(),
  superpowers: z.boolean().optional(),
});

/** "Bring in your history" (install-import B9, B13): ticked hosts and kinds, each once, and up to 100 proposal ids. */
export const ImportRunSchema: z.ZodType<ImportRunRequest> = z.object({
  from: z.array(z.enum(["claude", "codex"])).min(1).max(2).refine((a) => new Set(a).size === a.length, "each host once"),
  only: z.array(z.enum(["instructions", "memories", "projects", "mcp", "sessions"])).min(1).max(5).refine((a) => new Set(a).size === a.length, "each kind once"),
  accept: z.array(Text(1024)).max(100),
}).strict();
/** The host whose wiring an earlier install left on (inspection F7), and the choice it would be dropped by. */
export const UnwireArgs = z.object({ host: z.enum(["claude", "codex"]), choice: z.enum(["claude", "codex", "both", "none"]) }).strict();

// Sessions (spec 2026-10-07-unidex-sessions S3): the page names a workspace, a thread, a host, a prompt or a file; main
// and the runtime decide everything else.
/** A thread id, as main makes them (randomUUID). */
const ThreadId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
/** A folder under <vault>/workspaces: one segment, not hidden, not the team worktrees (services/sessions.ts WORKSPACE_RE). */
const WorkspaceName = z.string().max(128).regex(/^[^._/\\\0][^/\\\0]*$/);
const Prompt = z.string().max(64 * 1024).refine((s) => s.trim().length > 0 && !s.includes("\0"), "a prompt");
/** A model, never one that could read as a flag. */
const SessionModel = Model.refine((s) => !s.startsWith("-"), "a model name");

/** Every level either host takes; the runtime passes a host only its own (headless.js SESSION_EFFORTS). */
const SessionEffort = z.enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const SessionAccess = z.enum(["read", "edit", "run"]);

export const SessionStartSchema: z.ZodType<SessionStartRequest> = z.object({
  workspace: WorkspaceName,
  host: z.enum(["claude", "codex"]),
  text: Prompt,
  model: SessionModel.nullable().optional(),
  effort: SessionEffort.nullable().optional(),
  access: SessionAccess.optional(),
  allowCommands: z.boolean().optional(),
}).strict();
export const SessionSendSchema: z.ZodType<SessionSendRequest> = z.object({
  thread: ThreadId,
  text: Prompt,
  model: SessionModel.nullable().optional(),
  effort: SessionEffort.nullable().optional(),
  access: SessionAccess.optional(),
  allowCommands: z.boolean().optional(),
}).strict();
export const SessionCatalogArgs = z.object({ refresh: z.literal(true).optional() }).strict();
export const ThreadArgs = z.object({ thread: ThreadId }).strict();
export const GitStatusArgs = z.object({ workspace: WorkspaceName }).strict();
export const GitDiffArgs = z.object({ workspace: WorkspaceName, file: Text(4096).refine((f) => f.length > 0, "a file").optional() }).strict();
export const GitCommitArgs = z.object({ workspace: WorkspaceName, message: Text(64 * 1024).refine((m) => m.trim().length > 0, "a message") }).strict();
