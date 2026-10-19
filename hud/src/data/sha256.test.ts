import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha256Hex } from "./sha256";

const node = (s: string): string => createHash("sha256").update(s).digest("hex");

test("sha256Hex matches the FIPS 180-4 vectors", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"), "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
});

test("sha256Hex hashes the UTF-8 bytes, as lib/memory-ops.js does, across every padding boundary", () => {
  const memory = "---\ntype: memory\ntags: [memory/feedback, status/active]\nreviewed: false\n---\n\n# Ünïcödé — “quotes” 🧠\n\nBody\r\n";
  assert.equal(sha256Hex(memory), node(memory));
  for (let n = 0; n <= 200; n++) {
    const s = "x".repeat(n) + (n % 3 === 0 ? "é" : "");
    assert.equal(sha256Hex(s), node(s), `length ${n}`);
  }
  const big = "line of text\n".repeat(5000);
  assert.equal(sha256Hex(big), node(big));
});
