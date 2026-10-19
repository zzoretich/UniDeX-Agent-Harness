/**
 * Vault root setting: the whole decision for ONE commit of the field, as a pure function.
 *
 * It lives here rather than in src/settings.ts because the `obsidian` npm package is types-only
 * ("main": ""), so settings.ts can never be imported by `node --test` and nothing in it can be tested.
 *
 * Plan 4 Ruling F12: the field used to save inside Obsidian's per-keystroke `onChange`, which
 * (1) stacked one 10 s differing-directory Notice per accepted directory-prefix keystroke while typing,
 * (2) left an abandoned typo's last accepted directory prefix saved, and
 * (3) showed "X is not a directory — keeping X" on focus+blur of a saved directory that had vanished.
 * Committing once, on blur, with an equality short-circuit removes all three.
 */
import * as path from "path";

export const DIFFERING_VAULT_NOTICE =
  "Pulse/Runs/Memory/Spaces render the vault the app opened; the Vault root governs spawns, the live-runs watcher, brain/config.json and provider-state.json.";
export const DIFFERING_VAULT_NOTICE_MS = 10000;

export interface VaultRootInput {
  typed: string;                        // the raw field value at commit time
  saved: string;                        // settings.vaultRoot as stored ("" = this vault)
  basePath: string;                     // the open Obsidian vault's base path
  isDirectory: (p: string) => boolean;
}

export interface VaultRootDecision {
  action: "none" | "reject" | "save";
  value: string;                        // what the field should show afterwards
  notice: string | null;
  noticeMs?: number;
}

export function decideVaultRoot({ typed, saved, basePath, isDirectory }: VaultRootInput): VaultRootDecision {
  const trimmed = typed.trim();
  // Nothing changed — never re-validate what is already saved, so a saved directory that has since
  // been deleted produces silence rather than a Notice naming itself as its own replacement.
  if (trimmed === saved) return { action: "none", value: saved, notice: null };
  if (trimmed && !isDirectory(trimmed)) {
    return {
      action: "reject",
      value: saved,
      notice: `Vault root: ${trimmed} is not a directory — keeping ${saved || "(this vault)"}`,
    };
  }
  if (trimmed && path.resolve(trimmed) !== path.resolve(basePath)) {
    return { action: "save", value: trimmed, notice: DIFFERING_VAULT_NOTICE, noticeMs: DIFFERING_VAULT_NOTICE_MS };
  }
  return { action: "save", value: trimmed, notice: null };
}
