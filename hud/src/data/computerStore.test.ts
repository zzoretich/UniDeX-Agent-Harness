// The Computer pane's one store (agent-computer D27, D32, D35; ruling R51): main sends every computer's state on each
// change and a reveal when an ask's desktop notification is clicked; the store keeps the latest state per place for both
// pages' panes, the Code and Sessions rail badges and the row dots. A fake HostComputer stands in for main.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { HostComputer, HostComputerAsk, HostComputerEvent, HostComputerState } from "../host";
import { ComputerStore, pageOfSession, pageToOpen, storeFor } from "./computerStore";

function fakeComputer() {
  const subs: Array<(ev: HostComputerEvent) => void> = [];
  const host: HostComputer = {
    select: async () => null, show: () => {}, navigate: async () => ({ ok: true, data: null }), tab: () => {}, nav: () => {}, takeOver: () => {},
    handBack: () => {}, answer: () => {}, mark: () => {}, popOut: () => {},
    onEvent: (cb) => { subs.push(cb); return () => { subs.splice(subs.indexOf(cb), 1); }; },
  };
  return { host, subs, emit: (ev: HostComputerEvent) => { for (const cb of [...subs]) cb(ev); } };
}

const ask = (id: string, session: string, at: number, computer = "ws:harbor-map"): HostComputerAsk => ({
  id, at, computer, session, sessionLabel: "Claude Code in harbor-map", why: "unmarked", title: "Click: Continue on example.com?",
  detail: "The button “Continue”. Page: https://example.com/", site: "https://example.com", always: true,
});
const state = (place: string, o: Partial<HostComputerState> = {}): HostComputerState => ({
  place, tabs: [], holder: null, asks: [], log: [], marked: false, poppedOut: false, ...o,
});

test("pageOfSession reads the agent key's prefix: code:<terminal> is Code, chat:<thread> is Sessions", () => {
  assert.equal(pageOfSession("code:t3"), "code");
  assert.equal(pageOfSession("chat:5d2e"), "chat");
  assert.equal(pageOfSession("duty:wrap"), null);
  assert.equal(pageOfSession(""), null);
});

test("the badges count pending asks across every place, by the page their session belongs to", () => {
  const f = fakeComputer();
  const store = new ComputerStore(f.host);
  f.emit({ type: "state", state: state("ws:harbor-map", { asks: [ask("a1", "chat:th1", 10), ask("a2", "code:t5", 20)] }) });
  f.emit({ type: "state", state: state("vault", { asks: [ask("a3", "code:t7", 30, "vault")] }) });
  assert.equal(store.badge("code"), 2);
  assert.equal(store.badge("chat"), 1);
  assert.deepEqual(store.asks("code").map((a) => a.id), ["a2", "a3"], "oldest first");
  // The next state of a place replaces the last one: its answered asks are gone.
  f.emit({ type: "state", state: state("ws:harbor-map") });
  assert.equal(store.badge("code"), 1);
  assert.equal(store.badge("chat"), 0);
  assert.equal(store.ask("a3")?.computer, "vault");
  assert.equal(store.ask("a1"), null);
});

test("a row's dot: its session holds the wheel at a place not on screen, or waits on an ask; waiting only for an ask", () => {
  const f = fakeComputer();
  const store = new ComputerStore(f.host);
  const driving = { kind: "agent" as const, session: "code:t5", label: "Claude Code in harbor-map" };
  f.emit({ type: "state", state: state("ws:harbor-map", { holder: driving }) });
  assert.deepEqual(store.marks("code:t5"), { dot: true, waiting: false }, "off-screen while no pane shows it");
  store.setOnScreen("code", "ws:harbor-map");
  assert.deepEqual(store.marks("code:t5"), { dot: false, waiting: false }, "on screen: no dot");
  store.setOnScreen("code", null);
  f.emit({ type: "state", state: state("vault", { asks: [ask("a1", "chat:th1", 10, "vault")] }) });
  assert.deepEqual(store.marks("chat:th1"), { dot: true, waiting: true }, "an ask shows wherever the pane is");
  store.setOnScreen("chat", "vault");
  assert.deepEqual(store.marks("chat:th1"), { dot: true, waiting: true });
  assert.deepEqual(store.marks("code:t9"), { dot: false, waiting: false });
  assert.deepEqual(store.marks(null), { dot: false, waiting: false }, "a shell has no agent key");
  // The person driving is no session's dot.
  f.emit({ type: "state", state: state("ws:harbor-map", { holder: { kind: "user", resume: { session: "code:t5", label: "Claude Code" } } }) });
  assert.deepEqual(store.marks("code:t5"), { dot: false, waiting: false });
});

test("while main's computers are popped out, the selected one counts as on screen; the others do not", () => {
  const f = fakeComputer();
  const store = new ComputerStore(f.host);
  const holder = (session: string) => ({ kind: "agent" as const, session, label: "Claude Code" });
  f.emit({ type: "state", state: state("vault", { holder: holder("code:t7") }) });
  f.emit({ type: "state", state: state("ws:harbor-map", { holder: holder("code:t5"), poppedOut: true }) });
  assert.equal(store.marks("code:t5").dot, true, "nothing selected yet");
  store.noteSelected("ws:harbor-map");
  assert.equal(store.marks("code:t5").dot, false, "in its own window");
  assert.equal(store.marks("code:t7").dot, true, "another computer stays off-screen");
  f.emit({ type: "state", state: state("ws:harbor-map", { holder: holder("code:t5"), poppedOut: false }) });
  assert.equal(store.marks("code:t5").dot, true, "back in the pane, which gives it no rectangle");
});

test("one subscription to the host for every reader of the same host; readers hear each change; destroy lets it go", () => {
  const f = fakeComputer();
  const a = storeFor(f.host);
  assert.equal(storeFor(f.host), a, "the panes, the badges and the rows share one store");
  assert.equal(f.subs.length, 1);
  let heard = 0;
  const off = a.subscribe(() => { heard++; });
  f.emit({ type: "state", state: state("vault") });
  a.setOnScreen("chat", "vault");
  a.setOnScreen("chat", "vault");
  assert.equal(heard, 2, "an unchanged on-screen place is no change");
  off();
  f.emit({ type: "state", state: state("vault") });
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
  f.emit({ type: "state", state: state("vault", { asks: [ask("a1", "chat:th1", 10, "vault")] }) });
  assert.equal(store.pageToOpen(), "chat");
});

test("a reveal is told to its readers and kept until a pane takes it; it is dropped once its ask has gone", () => {
  const f = fakeComputer();
  const store = new ComputerStore(f.host);
  const told: string[] = [];
  store.onReveal((id) => told.push(id));
  f.emit({ type: "state", state: state("vault", { asks: [ask("a1", "chat:th1", 10, "vault")] }) });
  f.emit({ type: "reveal", askId: "a1" });
  assert.deepEqual(told, ["a1"]);
  assert.equal(store.revealing(), "a1");
  assert.equal(store.takeReveal("a2"), false, "only the ask asked for");
  assert.equal(store.takeReveal("a1"), true);
  assert.equal(store.revealing(), null);
  f.emit({ type: "reveal", askId: "a1" });
  f.emit({ type: "state", state: state("vault") });
  assert.equal(store.revealing(), null, "answered elsewhere: nothing left to show");
});

test("M5: a page's own ask (no agent holds the wheel) is routed by its place: the session that last drove that computer, else a pane that follows it", () => {
  const f = fakeComputer();
  const store = new ComputerStore(f.host);
  const download = { ...ask("p1", "page", 10), why: "download" };
  // Nobody known for the place and no pane on it: nowhere to send it.
  f.emit({ type: "state", state: state("ws:harbor-map", { asks: [download] }) });
  assert.equal(store.route(download), null);
  assert.equal(store.badge("code") + store.badge("chat"), 0);
  // A Code agent drove it, then its turn ended (no holder): the ask goes to that terminal's page and session.
  f.emit({ type: "state", state: state("ws:harbor-map", { holder: { kind: "agent", session: "code:t5", label: "Claude Code in harbor-map" } }) });
  f.emit({ type: "state", state: state("ws:harbor-map", { holder: null, asks: [download] }) });
  assert.deepEqual(store.route(download), { page: "code", session: "code:t5" });
  assert.equal(store.badge("code"), 1);
  assert.deepEqual(store.asks("code").map((a) => a.id), ["p1"]);
  assert.equal(store.pageToOpen(), "code", "Open the Computer pane goes there too");
  // An agent's own ask still goes by its session.
  assert.deepEqual(store.route(ask("a1", "chat:th1", 20)), { page: "chat", session: "chat:th1" });
  // A place no agent drove in this window, followed by the Sessions pane: that page, no session to select.
  const other = { ...ask("p2", "page", 30, "vault"), why: "permission" };
  store.noteFollowed("chat", "vault");
  f.emit({ type: "state", state: state("vault", { asks: [other] }) });
  assert.deepEqual(store.route(other), { page: "chat", session: null });
  assert.equal(store.badge("chat"), 1);
  store.noteFollowed("chat", null);
  assert.equal(store.route(other), null);
});
