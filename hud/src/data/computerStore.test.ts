// The Computer pane's one store (agent-computer D27, D32, D35; ruling R51): main sends every computer's state on each
// change and a reveal when an ask's desktop notification is clicked; the store keeps the latest state per session for both
// pages' panes, the Code and Sessions rail badges and the row dots. A fake HostComputer stands in for main.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { HostComputer, HostComputerAsk, HostComputerEvent, HostComputerState } from "../host";
import { ComputerStore, chatSession, codeSession, pageOfSession, pageToOpen, storeFor } from "./computerStore";

function fakeComputer() {
  const subs: Array<(ev: HostComputerEvent) => void> = [];
  const host: HostComputer = {
    select: async () => null, show: () => {}, navigate: async () => ({ ok: true, data: null }), openLink: async () => ({ ok: true, data: null }), tab: () => {}, nav: () => {}, takeOver: () => {},
    handBack: () => {}, answer: () => {}, mark: () => {}, popOut: () => {}, power: () => {}, describe: () => {}, move: () => Promise.resolve(false),
    onEvent: (cb) => { subs.push(cb); return () => { subs.splice(subs.indexOf(cb), 1); }; },
  };
  return { host, subs, emit: (ev: HostComputerEvent) => { for (const cb of [...subs]) cb(ev); } };
}

const ask = (id: string, session: string, at: number, computer = session): HostComputerAsk => ({
  id, at, computer, session, sessionLabel: "Claude Code in harbor-map", why: "unmarked", title: "Click: Continue on example.com?",
  detail: "The button “Continue”. Page: https://example.com/", site: "https://example.com", always: true,
});
const state = (session: string, o: Partial<HostComputerState> = {}): HostComputerState => ({
  session, label: "", tabs: [], holder: null, asks: [], log: [], marked: false, poppedOut: false, power: "awake", ...o,
});

test("pageOfSession reads the agent key's prefix: code:<terminal> is Code, chat:<thread> is Sessions", () => {
  assert.equal(pageOfSession("code:t3"), "code");
  assert.equal(pageOfSession("chat:5d2e"), "chat");
  assert.equal(pageOfSession("duty:wrap"), null);
  assert.equal(pageOfSession(""), null);
});

test("the session keys: codeSession and chatSession", () => {
  assert.equal(codeSession("t3"), "code:t3");
  assert.equal(chatSession("5d2e"), "chat:5d2e");
});

test("the badges count pending asks across every browser, by the page their session belongs to", () => {
  const f = fakeComputer();
  const store = new ComputerStore(f.host);
  f.emit({ type: "state", state: state("code:t5", { asks: [ask("a2", "code:t5", 20)] }) });
  f.emit({ type: "state", state: state("chat:th1", { asks: [ask("a1", "chat:th1", 10)] }) });
  f.emit({ type: "state", state: state("code:t7", { asks: [ask("a3", "code:t7", 30)] }) });
  assert.equal(store.badge("code"), 2);
  assert.equal(store.badge("chat"), 1);
  assert.deepEqual(store.asks("code").map((a) => a.id), ["a2", "a3"], "oldest first");
  // The next state of a session replaces the last one: its answered asks are gone.
  f.emit({ type: "state", state: state("code:t5") });
  assert.equal(store.badge("code"), 1);
  assert.equal(store.ask("a3")?.computer, "code:t7");
  assert.equal(store.ask("a2"), null);
});

test("the store keeps one state per session and a row's dot is its own browser's: its agent drives it while no pane shows it, or it waits on an ask", () => {
  const f = fakeComputer();
  const store = new ComputerStore(f.host);
  const driving = { kind: "agent" as const, session: "code:t5", label: "Claude Code in harbor-map" };
  f.emit({ type: "state", state: state("code:t5", { holder: driving }) });
  f.emit({ type: "state", state: state("code:t6", { holder: { ...driving, session: "code:t6" } }) });
  assert.equal(store.state("code:t5")?.holder?.kind, "agent");
  assert.equal(store.state("code:t6")?.session, "code:t6", "two sessions, two states");
  assert.deepEqual(store.marks("code:t5"), { dot: true, waiting: false }, "off-screen while no pane shows it");
  store.setOnScreen("code", "code:t5");
  assert.deepEqual(store.marks("code:t5"), { dot: false, waiting: false }, "on screen: no dot");
  assert.deepEqual(store.marks("code:t6"), { dot: true, waiting: false }, "another session's browser on screen changes nothing here");
  store.setOnScreen("code", null);
  f.emit({ type: "state", state: state("chat:th1", { asks: [ask("a1", "chat:th1", 10)] }) });
  assert.deepEqual(store.marks("chat:th1"), { dot: true, waiting: true }, "an ask shows wherever the pane is");
  store.setOnScreen("chat", "chat:th1");
  assert.deepEqual(store.marks("chat:th1"), { dot: true, waiting: true });
  assert.deepEqual(store.marks("code:t9"), { dot: false, waiting: false });
  assert.deepEqual(store.marks(null), { dot: false, waiting: false }, "a row with no session");
  // The person driving is no session's dot.
  f.emit({ type: "state", state: state("code:t5", { holder: { kind: "user", resume: { session: "code:t5", label: "Claude Code" } } }) });
  assert.deepEqual(store.marks("code:t5"), { dot: false, waiting: false });
});

test("while main's computers are popped out, the selected one counts as on screen; the others do not", () => {
  const f = fakeComputer();
  const store = new ComputerStore(f.host);
  const holder = (session: string) => ({ kind: "agent" as const, session, label: "Claude Code" });
  f.emit({ type: "state", state: state("code:t7", { holder: holder("code:t7") }) });
  f.emit({ type: "state", state: state("code:t5", { holder: holder("code:t5"), poppedOut: true }) });
  assert.equal(store.marks("code:t5").dot, true, "nothing selected yet");
  store.noteSelected("code:t5");
  assert.equal(store.marks("code:t5").dot, false, "in its own window");
  assert.equal(store.marks("code:t7").dot, true, "another browser stays off-screen");
  f.emit({ type: "state", state: state("code:t5", { holder: holder("code:t5"), poppedOut: false }) });
  assert.equal(store.marks("code:t5").dot, true, "back in the pane, which gives it no rectangle");
});

test("one subscription to the host for every reader of the same host; readers hear each change; destroy lets it go", () => {
  const f = fakeComputer();
  const a = storeFor(f.host);
  assert.equal(storeFor(f.host), a, "the panes, the badges and the rows share one store");
  assert.equal(f.subs.length, 1);
  let heard = 0;
  const off = a.subscribe(() => { heard++; });
  f.emit({ type: "state", state: state("code:t9") });
  a.setOnScreen("chat", "code:t9");
  a.setOnScreen("chat", "code:t9");
  assert.equal(heard, 2, "an unchanged on-screen session is no change");
  off();
  f.emit({ type: "state", state: state("code:t9") });
  assert.equal(heard, 2);
  a.destroy();
  assert.equal(f.subs.length, 0);
});

test("Open the Computer pane (R50): the page with asks, the oldest ask's page when both have some, else the page that last showed the pane, else Sessions", () => {
  assert.equal(pageToOpen([ask("a1", "code:t5", 10)], "chat"), "code");
  assert.equal(pageToOpen([ask("a1", "chat:th1", 10)], "code"), "chat");
  assert.equal(pageToOpen([ask("a1", "chat:th1", 30), ask("a2", "code:t5", 20)], null), "code", "the oldest ask's page");
  assert.equal(pageToOpen([ask("a1", "chat:th1", 10), ask("a2", "code:t5", 20)], "code"), "chat");
  assert.equal(pageToOpen([], "code"), "code");
  assert.equal(pageToOpen([], null), "chat");
  const f = fakeComputer();
  const store = new ComputerStore(f.host);
  assert.equal(store.pageToOpen(), "chat");
  store.noteShown("code");
  assert.equal(store.pageToOpen(), "code", "the page that last showed the pane");
  f.emit({ type: "state", state: state("chat:th1", { asks: [ask("a1", "chat:th1", 10)] }) });
  assert.equal(store.pageToOpen(), "chat");
});

test("a reveal is told to its readers and kept until a pane takes it; it is dropped once its ask has gone", () => {
  const f = fakeComputer();
  const store = new ComputerStore(f.host);
  const told: string[] = [];
  store.onReveal((id) => told.push(id));
  f.emit({ type: "state", state: state("chat:th1", { asks: [ask("a1", "chat:th1", 10)] }) });
  f.emit({ type: "reveal", askId: "a1" });
  assert.deepEqual(told, ["a1"]);
  assert.equal(store.revealing(), "a1");
  assert.equal(store.takeReveal("a2"), false, "only the ask asked for");
  assert.equal(store.takeReveal("a1"), true);
  assert.equal(store.revealing(), null);
  f.emit({ type: "reveal", askId: "a1" });
  f.emit({ type: "state", state: state("chat:th1") });
  assert.equal(store.revealing(), null, "answered elsewhere: nothing left to show");
});

test("M5: a page's own ask (no agent holds the wheel) is routed by its browser: the page and session its computer names", () => {
  const f = fakeComputer();
  const store = new ComputerStore(f.host);
  const download = { ...ask("p1", "page", 10, "code:t5"), why: "download" };
  f.emit({ type: "state", state: state("code:t5", { asks: [download] }) });
  assert.deepEqual(store.route(download), { page: "code", session: "code:t5" });
  assert.equal(store.badge("code"), 1);
  assert.deepEqual(store.asks("code").map((a) => a.id), ["p1"]);
  assert.deepEqual(store.marks("code:t5"), { dot: true, waiting: true }, "its row waits on it");
  assert.equal(store.pageToOpen(), "code", "Open the Computer pane goes there too");
  // An agent's own ask still goes by its session.
  assert.deepEqual(store.route(ask("a1", "chat:th1", 20)), { page: "chat", session: "chat:th1" });
  // A page ask on a browser that is no session's (nothing here can show it): nowhere.
  assert.equal(store.route({ ...ask("p2", "page", 30, "vault"), why: "permission" }), null);
});
