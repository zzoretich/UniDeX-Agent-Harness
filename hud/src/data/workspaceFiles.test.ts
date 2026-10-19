import { test } from "node:test";
import assert from "node:assert";
import { isIgnored } from "./workspaceFiles";
import { sortEntries, type DirEntry } from "./workspaceFiles";
import { mapSkipReason, mapSkipsDir, MAP_MAX_SIZE } from "./workspaceFiles";
import { createRequire } from "module";

test("isIgnored drops .git, node_modules, .DS_Store", () => {
  assert.equal(isIgnored(".git"), true);
  assert.equal(isIgnored("node_modules"), true);
  assert.equal(isIgnored(".DS_Store"), true);
  assert.equal(isIgnored("src"), false);
  assert.equal(isIgnored("README.md"), false);
});

test("sortEntries puts folders first, then alpha within each group", () => {
  const input: DirEntry[] = [
    { name: "zebra.md", isDir: false },
    { name: "src", isDir: true },
    { name: "alpha.md", isDir: false },
    { name: "Brain", isDir: true },
  ];
  const out = sortEntries(input).map((e) => e.name);
  assert.deepEqual(out, ["Brain", "src", "alpha.md", "zebra.md"]);
});

import { looksTextual, listDir } from "./workspaceFiles";
import { promises as fs } from "fs";
import * as os from "os";
import * as nodePath from "path";

test("looksTextual: known text extension passes", () => {
  assert.equal(looksTextual("main.ts", Buffer.from("export const x = 1")), true);
});

test("looksTextual: dotfile basename passes", () => {
  assert.equal(looksTextual(".gitignore", Buffer.from("node_modules\n")), true);
});

test("looksTextual: NUL byte in sample ⇒ binary", () => {
  assert.equal(looksTextual("mystery.dat", Buffer.from([0x41, 0x00, 0x42])), false);
});

test("looksTextual: unknown ext, clean sample ⇒ text", () => {
  assert.equal(looksTextual("notes.weird", Buffer.from("plain text")), true);
});

test("looksTextual: unknown ext, empty sample ⇒ not text", () => {
  assert.equal(looksTextual("mystery.dat", Buffer.alloc(0)), false);
});

test("looksTextual: known text ext, empty sample ⇒ still text", () => {
  assert.equal(looksTextual("empty.ts", Buffer.alloc(0)), true);
});

import { truncate, MAX_PREVIEW_LINES, MAX_PREVIEW_BYTES } from "./workspaceFiles";

test("truncate: short text is untouched", () => {
  const r = truncate("hello\nworld");
  assert.equal(r.text, "hello\nworld");
  assert.equal(r.truncated, false);
});

test("truncate: over the line cap is flagged and cut", () => {
  const big = Array.from({ length: MAX_PREVIEW_LINES + 100 }, (_, i) => `line ${i}`).join("\n");
  const r = truncate(big);
  assert.equal(r.truncated, true);
  assert.equal(r.text.split("\n").length, MAX_PREVIEW_LINES);
});

test("truncate: over the byte cap is flagged and cut within the cap", () => {
  const big = "a".repeat(MAX_PREVIEW_BYTES + 500);
  const r = truncate(big);
  assert.equal(r.truncated, true);
  assert.ok(Buffer.byteLength(r.text, "utf8") <= MAX_PREVIEW_BYTES);
});

test("truncate: byte cap respects multibyte boundaries", () => {
  const big = "あ".repeat(MAX_PREVIEW_BYTES); // 3 bytes each ⇒ well over the cap
  const r = truncate(big);
  assert.equal(r.truncated, true);
  assert.ok(Buffer.byteLength(r.text, "utf8") <= MAX_PREVIEW_BYTES);
});

test("listDir: filters IGNORED, returns sorted folders-then-files", async () => {
  const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "wsfiles-"));
  try {
    await fs.mkdir(nodePath.join(dir, "src"));
    await fs.mkdir(nodePath.join(dir, ".git"));
    await fs.mkdir(nodePath.join(dir, "node_modules"));
    await fs.writeFile(nodePath.join(dir, "README.md"), "hi");
    await fs.writeFile(nodePath.join(dir, ".DS_Store"), "x");

    const entries = await listDir(dir);
    assert.deepEqual(
      entries.map((e) => `${e.isDir ? "d" : "f"}:${e.name}`),
      ["d:src", "f:README.md"],
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

import { readPreview } from "./workspaceFiles";

test("readPreview: text / empty / binary classification", async () => {
  const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "wsprev-"));
  try {
    const txt = nodePath.join(dir, "a.txt");
    await fs.writeFile(txt, "hello world");
    const rTxt = await readPreview(txt);
    assert.equal(rTxt.kind, "text");
    assert.equal(rTxt.text, "hello world");
    assert.equal(rTxt.truncated, false);

    const empty = nodePath.join(dir, "empty.txt");
    await fs.writeFile(empty, "");
    assert.equal((await readPreview(empty)).kind, "empty");

    const bin = nodePath.join(dir, "blob.bin");
    await fs.writeFile(bin, Buffer.from([0x00, 0x01, 0x02, 0x00]));
    assert.equal((await readPreview(bin)).kind, "binary");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("readPreview: large file is flagged truncated and capped", async () => {
  const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "wsprev2-"));
  try {
    const big = nodePath.join(dir, "big.txt");
    await fs.writeFile(big, "a".repeat(MAX_PREVIEW_BYTES + 1000));
    const r = await readPreview(big);
    assert.equal(r.kind, "text");
    assert.equal(r.truncated, true);
    assert.ok(Buffer.byteLength(r.text ?? "", "utf8") <= MAX_PREVIEW_BYTES);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("listDir records each file's size", async () => {
  const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "wssize-"));
  try {
    await fs.mkdir(nodePath.join(dir, "src"));
    await fs.writeFile(nodePath.join(dir, "a.md"), "hello");
    const entries = await listDir(dir);
    assert.deepEqual(entries, [{ name: "src", isDir: true }, { name: "a.md", isDir: false, size: 5 }]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("mapSkipReason: dot segments but .github, skipped folders, lock files, binary types, over 1 MB", () => {
  assert.equal(mapSkipReason("src/main.ts", 10), null);
  assert.equal(mapSkipReason(".github/workflows/ci.yml", 10), null);
  assert.equal(mapSkipReason(".env", 10), "hidden");
  assert.equal(mapSkipReason("a/.cache/x.md", 10), "hidden");
  assert.equal(mapSkipReason("dist/app.js", 10), "folder");
  assert.equal(mapSkipReason("pkg/node_modules/x.js", 10), "folder");
  assert.equal(mapSkipReason("package-lock.json", 10), "name");
  assert.equal(mapSkipReason("art/Logo.PNG", 10), "type");
  assert.equal(mapSkipReason("data.json", MAP_MAX_SIZE + 1), "size");
  assert.equal(mapSkipReason("data.json", MAP_MAX_SIZE), null);
  assert.equal(mapSkipReason("data.json"), null, "an unknown size passes");
  assert.equal(mapSkipsDir("dist"), true);
  assert.equal(mapSkipsDir(".github"), false);
  assert.equal(mapSkipsDir("src/.venv/lib"), true);
  assert.equal(mapSkipsDir("src"), false);
});

/**
 * collectors/fileMap.js resolves a vault as it loads (lib/paths.js): give it an empty temp vault and no agenticos.json,
 * so this never reads the developer's own config or vault (terminalLaunch.test.ts's loadCollector precedent).
 */
async function loadFileMap(): Promise<{ mappableFile: (abs: string, rel: string) => boolean }> {
  const vault = await fs.mkdtemp(nodePath.join(os.tmpdir(), "aos-filemap-vault-"));
  await fs.mkdir(nodePath.join(vault, "brain", "_index"), { recursive: true });
  const saved = { vault: process.env.AOS_VAULT, config: process.env.AOS_CONFIG };
  process.env.AOS_VAULT = vault;
  process.env.AOS_CONFIG = nodePath.join(vault, "no-agenticos.json");
  try {
    return createRequire(__filename)(nodePath.resolve(__dirname, "../../../brain/scripts/collectors/fileMap.js"));
  } finally {
    for (const [k, v] of [["AOS_VAULT", saved.vault], ["AOS_CONFIG", saved.config]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await fs.rm(vault, { recursive: true, force: true });
  }
}

test("mapSkipReason mirrors the runtime's fileMap.js mappableFile, case for case", async () => {
  const runtime = await loadFileMap();
  const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "wsmap-"));
  const cases: Array<[string, number]> = [
    ["README.md", 10], ["src/main.ts", 10], [".github/workflows/ci.yml", 10], [".env", 10], ["a/.cache/x.md", 10],
    ["dist/app.js", 10], ["build/x.js", 10], [".obsidian/app.json", 10], ["__pycache__/x.pyc", 10], [".venv/bin/x", 10],
    ["pkg/node_modules/x.js", 10], ["package-lock.json", 10], ["yarn.lock", 10], ["Cargo.lock", 10], [".DS_Store", 10],
    ["art/logo.png", 10], ["art/Logo.SVG", 10], ["deck.pptx", 10], ["lib.dylib", 10], ["fonts/a.woff2", 10],
    ["big.json", MAP_MAX_SIZE + 1], ["edge.json", MAP_MAX_SIZE], ["_notes/x.md", 10], ["Makefile", 10],
  ];
  try {
    for (const [rel, size] of cases) {
      const abs = nodePath.join(dir, rel);
      await fs.mkdir(nodePath.dirname(abs), { recursive: true });
      await fs.writeFile(abs, Buffer.alloc(size, 97));
      assert.equal(mapSkipReason(rel, size) === null, runtime.mappableFile(abs, rel), rel);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
