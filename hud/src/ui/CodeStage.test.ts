// Code ▸ History over the stage (remove-sessions D3): the stage changes what it shows, and the panel that asked draws the
// sidebar once after (TerminalPanel.showHistory and closeHistory). The stage drawing it too drew it twice on every show.
// "obsidian" resolves to a stub under node:test; History is a stand-in that records show and hide.
import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import type * as Stage from "./CodeStage";

const STUB = "obsidian-stub-code-stage";
const M = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string };
const resolve = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "obsidian" ? STUB : resolve.call(this, request, ...rest);
};
require.cache[STUB] = { id: STUB, filename: STUB, loaded: true, exports: { setIcon: () => {}, Notice: class {} } } as unknown as NodeJS.Module;
const { CodeStage } = require("./CodeStage") as typeof Stage;

function stage() {
  let draws = 0;
  const host = { activeId: () => null, activeSession: () => undefined, composer: () => null, setView: () => {}, openLink: () => {}, renderTabs: () => { draws++; } };
  const s = new CodeStage({} as never, host, {} as never);
  const history = { shown: false, show() { this.shown = true; }, hide() { this.shown = false; } };
  s.history = history as never;
  return { s, draws: () => draws };
}

test("showHistory shows History over the stage and leaves the sidebar's drawing to the panel, as closeHistory does", () => {
  const { s, draws } = stage();
  s.showHistory();
  assert.equal(s.historyShown(), true);
  assert.equal(draws(), 0, "the panel draws the sidebar once after; the stage drawing it too drew it twice");
  s.closeHistory();
  assert.equal(s.historyShown(), false);
  assert.equal(draws(), 0);
});

test("showHistory puts away a past conversation open in the stage", () => {
  const { s } = stage();
  s.past = { key: "claude:abc", host: "claude", id: "abc", title: "Tide parser", place: { kind: "vault", label: "Vault", dir: "/v" }, resume: { state: "off", reason: "x" } as never };
  s.showHistory();
  assert.equal(s.past, null);
  assert.equal(s.covered(), true, "History still covers the terminal");
});
