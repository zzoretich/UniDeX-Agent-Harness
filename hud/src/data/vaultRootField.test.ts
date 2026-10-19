import { test } from "node:test";
import assert from "node:assert/strict";
import { decideVaultRoot, DIFFERING_VAULT_NOTICE } from "./vaultRootField";

const BASE = "/tmp/open-vault";
const OTHER = "/tmp/other-vault";
const dirs = new Set([BASE, OTHER]);
const isDirectory = (p: string) => dirs.has(p);

test("an unchanged value commits nothing and shows no Notice, even when the saved directory has vanished", () => {
  // Plan 4 Ruling F12 (3): focus+blur on a saved directory that has since been deleted used to show
  // the self-referential "X is not a directory — keeping X". "/tmp/gone" is deliberately not in `dirs`.
  assert.deepEqual(decideVaultRoot({ typed: "/tmp/gone", saved: "/tmp/gone", basePath: BASE, isDirectory }),
    { action: "none", value: "/tmp/gone", notice: null });
  assert.deepEqual(decideVaultRoot({ typed: `  ${OTHER}  `, saved: OTHER, basePath: BASE, isDirectory }),
    { action: "none", value: OTHER, notice: null });
});

test("a non-directory is rejected: the saved value comes back with one Notice and nothing is saved", () => {
  // Plan 4 Ruling F12 (2): an abandoned typo used to leave its last accepted directory prefix saved,
  // because every keystroke committed. A rejected commit restores the saved value instead.
  const d = decideVaultRoot({ typed: "/tmp/other-vau", saved: OTHER, basePath: BASE, isDirectory });
  assert.equal(d.action, "reject");
  assert.equal(d.value, OTHER, "the field is restored to the saved value");
  assert.equal(d.notice, `Vault root: /tmp/other-vau is not a directory — keeping ${OTHER}`);
  assert.equal(decideVaultRoot({ typed: "/tmp/nope", saved: "", basePath: BASE, isDirectory }).notice,
    "Vault root: /tmp/nope is not a directory — keeping (this vault)");
});

test("a directory that differs from the open vault saves and explains the setting exactly once", () => {
  // Plan 4 Ruling F12 (1): one decision per commit, so the 10 s Notice can no longer stack once per
  // accepted directory-prefix keystroke while the user types.
  const d = decideVaultRoot({ typed: OTHER, saved: "", basePath: BASE, isDirectory });
  assert.equal(d.action, "save");
  assert.equal(d.value, OTHER);
  assert.equal(d.notice, DIFFERING_VAULT_NOTICE);
  assert.equal(d.noticeMs, 10000);
});

test("a directory that IS the open vault saves with no Notice", () => {
  assert.deepEqual(decideVaultRoot({ typed: BASE, saved: "", basePath: BASE, isDirectory }),
    { action: "save", value: BASE, notice: null });
});

test("clearing the field saves the empty value (back to this vault) with no Notice", () => {
  assert.deepEqual(decideVaultRoot({ typed: "   ", saved: OTHER, basePath: BASE, isDirectory }),
    { action: "save", value: "", notice: null });
});
