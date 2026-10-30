// Types for write-areas.js, which the Workbench's Routines editor (hud/src/data/routines.ts) imports as it is:
// the routine write rule its runners enforce. Keep in step with the module's exports.
export declare const INSTRUCTIONS: readonly string[];
export declare const AGENT_INSTRUCTIONS: readonly string[];
export declare const GUARDED: readonly string[];
export declare const LEDGER: string;
export declare const EXECUTABLE: readonly string[];
export declare const LOCAL_DENY: ReadonlyArray<{ label: string; dir?: boolean; root?: boolean; why: string }>;
export declare function fold(p: string): string;
export declare function instructionKind(rel: string): 'self' | 'agent' | 'rule' | null;
export declare function refusal(rel: string): string | null;
export declare function localDenied(p: string): string | null;
export declare function vaultRel(p: unknown, opts?: { allowRoot?: boolean }): { rel: string; why?: undefined } | { why: string; rel?: undefined };
export declare function localPathRefusal(rel: string): string | null;
export declare function writesEntry(entry: string): { s: string; dir: boolean; body: string; glob: boolean; fixed: string };
export declare function localWritesRefusal(entry: string): string | null;
export declare function localOutputRefusal(file: string): string | null;
export declare function normEntry(entry: string): { rel: string; dir: boolean };
export declare function dutyWritesRefusal(entry: string): string | null;
