// setup:* and update:* — the first-run wizard, attach mode and the app's own updates (phase 5). The page names a check,
// a fix or a step; what each runs or downloads is main's (policy/setup.ts, setup/controller.ts, setup/toolchain.ts). The
// import step (install-import B13) names hosts, kinds and proposals from main's own last scan; the unwire, a host.
// Output and download progress come back as events.

import { CH, type ClaudeMdPreview, type HostId, type ImportRunRequest, type InstallRequest, type PathLinePreview, type PreflightReport, type Result, type SetupFixId, type UpdateState } from "../../shared/ipc";
import { FixArgs, ImportRunSchema, InstallRequestSchema, NoArgs, SetupInputArgs, SetupResizeArgs, UnwireArgs } from "./schemas";
import { onInvoke, onSend, onSync, type Trust } from "./trust";

export interface SetupIpc {
  preflight(): Promise<Result<PreflightReport>>;
  fix(id: SetupFixId, cols: number, rows: number): Result<null>;
  input(data: string): void;
  resize(cols: number, rows: number): void;
  cancel(): void;
  chooseVault(): Promise<Result<string | null>>;
  install(req: InstallRequest): Result<null>;
  claudeMd(): Result<ClaudeMdPreview>;
  applyClaudeMd(): Result<ClaudeMdPreview>;
  finish(): Result<null>;
  upgrade(): Result<null>;
  noted(): void;
  pathLine(): Result<PathLinePreview>;
  addToPath(): Result<PathLinePreview>;
  importScan(): Promise<Result<unknown>>;
  importHistory(req: ImportRunRequest): Result<null>;
  unwire(host: HostId, choice: InstallRequest["host"]): Result<null>;
}

export function registerSetupIpc(trust: Trust, s: SetupIpc): void {
  onInvoke(CH.setupPreflight, trust, NoArgs, () => s.preflight());
  onSync(CH.setupFix, trust, FixArgs, ({ id, cols, rows }) => s.fix(id, cols, rows));
  onSend(CH.setupInput, trust, SetupInputArgs, ({ data }) => s.input(data));
  onSend(CH.setupResize, trust, SetupResizeArgs, ({ cols, rows }) => s.resize(cols, rows));
  onSend(CH.setupCancel, trust, NoArgs, () => s.cancel());
  onInvoke(CH.setupChooseVault, trust, NoArgs, () => s.chooseVault());
  onSync(CH.setupInstall, trust, InstallRequestSchema, (req) => s.install(req));
  onSync(CH.setupClaudeMd, trust, NoArgs, () => s.claudeMd());
  onSync(CH.setupApplyClaudeMd, trust, NoArgs, () => s.applyClaudeMd());
  onSync(CH.setupFinish, trust, NoArgs, () => s.finish());
  onSync(CH.setupUpgrade, trust, NoArgs, () => s.upgrade());
  onSend(CH.setupNoted, trust, NoArgs, () => s.noted());
  onSync(CH.setupPathLine, trust, NoArgs, () => s.pathLine());
  onSync(CH.setupAddToPath, trust, NoArgs, () => s.addToPath());
  onInvoke(CH.setupImportScan, trust, NoArgs, () => s.importScan());
  onSync(CH.setupImport, trust, ImportRunSchema, (req) => s.importHistory(req));
  onSync(CH.setupUnwire, trust, UnwireArgs, ({ host, choice }) => s.unwire(host, choice));
}

export interface UpdateIpc {
  state(): UpdateState;
  check(): void;
  install(): void;
}

export function registerUpdateIpc(trust: Trust, u: UpdateIpc): void {
  onSync(CH.updateState, trust, NoArgs, () => ({ ok: true, data: u.state() }));
  onSend(CH.updateCheck, trust, NoArgs, () => u.check());
  onSend(CH.updateInstall, trust, NoArgs, () => u.install());
}
