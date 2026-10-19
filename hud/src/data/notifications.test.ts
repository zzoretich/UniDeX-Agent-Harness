import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import {
  NOTIFICATIONS_DIR, STATE_PATH, REACTIONS_PATH, notificationId, parseNotification, parseActions, parseState, withState,
  filterRows, senders, unreadBadge, headingSlug, splitSections, actionsFor, askCommand, parseReactions, setFlag, ago,
  Notification, AskAction,
} from "./notifications";
import { setFlags, appendReaction, NotificationAdapter } from "./notificationWriter";
import { touchesBadges } from "./badges";

// The fixture vault is read by both sides (spec D7): this module and brain/scripts/lib/notifications.js.
const VAULT = path.resolve(__dirname, "fixtures/notifications-vault");
const REPO = path.resolve(__dirname, "../../..");
const store = createRequire(__filename)(path.join(REPO, "brain/scripts/lib/notifications.js"));

function fixtureItems(): { items: Notification[]; unreadable: number } {
  const dir = path.join(VAULT, NOTIFICATIONS_DIR, "2026");
  const items: Notification[] = [];
  let unreadable = 0;
  for (const f of fs.readdirSync(dir).sort()) {
    const n = parseNotification(`${NOTIFICATIONS_DIR}/2026/${f}`, fs.readFileSync(path.join(dir, f), "utf8"));
    if (n) items.push(n); else unreadable++;
  }
  return { items, unreadable };
}
const fixtureRows = () => withState(fixtureItems().items, parseState(fs.readFileSync(path.join(VAULT, STATE_PATH), "utf8")));

test("the fixtures parse to the same items, levels, read and archived state as the runtime's list()", () => {
  const { unreadable } = fixtureItems();
  const rows = fixtureRows();
  const js = store.list(VAULT, { archived: true });
  assert.equal(unreadable, js.unreadable);
  assert.deepEqual(
    rows.map((r) => [r.id, r.from, r.level, r.title, r.created, r.read, r.archived, r.path]),
    js.items.map((i: Record<string, unknown>) => [i.id, i.from, i.level, i.title, i.created, i.read, i.archived, i.path]));
});

test("an item written by the runtime's post() parses back here with its actions intact", () => {
  const now = new Date("2026-09-24T11:00:00Z");
  const actions = [{ kind: "ask", label: "Deep dive", skill: "deep-dive", arg: "it's \"quoted\"", anchor: "lede" }, { kind: "react", label: "Less", value: -1, ref: "s1" }];
  const r = store.post({ from: "news-anchor", level: "alert", title: "Title: with \"quotes\" & colons", body: "## Lede\n\nText.", tags: ["news"], actions }, { vault: "/nonexistent", now, dryRun: true });
  const n = parseNotification(`${NOTIFICATIONS_DIR}/${now.getFullYear()}/${r.id}.md`, r.text);
  assert.ok(n);
  assert.equal(n.title, "Title: with \"quotes\" & colons");
  assert.deepEqual(n.actions, actions);
  assert.deepEqual(n.tags, ["news"]);
  assert.equal(n.body, "## Lede\n\nText.\n");
});

test("withState orders by created time, then id, like the runtime", () => {
  const base = { path: "", from: "a", level: "info" as const, title: "t", tags: [], actions: [], body: "" };
  const rows = withState([
    { ...base, id: "2026-09-24T0700-a-zebra", created: "2026-09-24T07:00:01-04:00" },
    { ...base, id: "2026-09-24T0700-a-alpha", created: "2026-09-24T07:00:20-04:00" },
    { ...base, id: "2026-09-23T0700-a-old", created: "2026-09-23T07:00:00-04:00" },
  ], {});
  assert.deepEqual(rows.map((r) => r.id), ["2026-09-24T0700-a-alpha", "2026-09-24T0700-a-zebra", "2026-09-23T0700-a-old"]);
});

test("notificationId accepts only year-folder item files", () => {
  assert.equal(notificationId("brain/notifications/2026/2026-09-24T0700-a-b.md"), "2026-09-24T0700-a-b");
  assert.equal(notificationId("brain/notifications/state.json"), null);
  assert.equal(notificationId("brain/notifications/2026-09-24T0700-a-b.md"), null);
  assert.equal(notificationId("brain/notifications/2026/notes.md"), null);
});

test("parseActions keeps only the allow-list: no command key, no unknown kind, no bad skill name", () => {
  const out = parseActions([
    { kind: "run", label: "x", command: "rm -rf ~" },
    { kind: "ask", label: "bad", skill: "a b; rm" },
    { kind: "ask", label: "ok", skill: "deep-dive", arg: "one\ntwo", command: "echo" },
    { kind: "react", label: "vote", value: 2, ref: "r" },
    { kind: "react", label: "vote", value: 1, ref: "r", anchor: "Not A Slug" },
    "string",
  ]);
  assert.deepEqual(out, [{ kind: "ask", label: "ok", skill: "deep-dive" }, { kind: "react", label: "vote", value: 1, ref: "r" }]);
});

test("filters: unread / all / archived views, level and sender; senders list", () => {
  const rows = fixtureRows();
  assert.deepEqual(filterRows(rows, { view: "unread" }).map((r) => r.level), ["breaking"]);
  assert.deepEqual(filterRows(rows, { view: "all" }).map((r) => r.level), ["breaking", "edition"]);
  assert.deepEqual(filterRows(rows, { view: "archived" }).map((r) => r.from), ["monitor"]);
  assert.deepEqual(filterRows(rows, { view: "all", level: "edition" }).map((r) => r.title), ["The Morning Edition"]);
  assert.deepEqual(filterRows(rows, { view: "all", from: "monitor" }), []);
  assert.deepEqual(senders(rows), ["monitor", "news-anchor"]);
});

test("the badge counts unread, unarchived items and flags an unread breaking one", () => {
  assert.deepEqual(unreadBadge(fixtureRows()), { count: 1, breaking: true });
  assert.deepEqual(unreadBadge([{ level: "edition", read: false, archived: false }, { level: "breaking", read: false, archived: true }]), { count: 1, breaking: false });
  assert.ok(touchesBadges("brain/notifications/state.json"));
  assert.ok(touchesBadges("brain/notifications/2026/2026-09-24T0700-a-b.md"));
  assert.ok(!touchesBadges("brain/notifications-old/x.md"));
});

test("sections split at ## headings and anchored actions land under theirs; stray anchors fall to the foot", () => {
  const n = fixtureItems().items.find((i) => i.level === "edition")!;
  const secs = splitSections(n.body);
  assert.deepEqual(secs.map((s) => [s.anchor, s.heading]), [[null, null], ["ai-and-tech", "AI and Tech"], ["weather", "Weather"]]);
  assert.equal(secs[1].text, "A new model shipped overnight.");
  const anchors = secs.map((s) => s.anchor);
  assert.deepEqual(actionsFor(n.actions, "ai-and-tech", anchors).map((a) => a.label), ["Deep dive", "More like this", "Less like this"]);
  assert.deepEqual(actionsFor(n.actions, null, anchors).map((a) => a.label), ["Weekly outlook"]);
  assert.deepEqual(actionsFor([{ kind: "react", label: "x", value: 1, ref: "r", anchor: "nowhere" }], null, anchors).map((a) => a.label), ["x"]);
  assert.equal(headingSlug("NYC — Weather & Events!"), "nyc-weather-events");
});

test("askCommand: one quoted command per host; $ never expands; direct-wired Codex drops the plugin prefix", () => {
  const a: AskAction = { kind: "ask", label: "x", skill: "deep-dive", arg: "it's $HOME" };
  assert.equal(askCommand(a, "claude", null), `claude '/deep-dive it'\\''s $HOME'`);
  assert.equal(askCommand(a, "codex", null), `codex '$deep-dive it'\\''s $HOME'`);
  const p: AskAction = { kind: "ask", label: "x", skill: "agenticos:ask-brain" };
  assert.equal(askCommand(p, "codex", { hosts: { codex: { enabled: true, install: "plugin" } } }), "codex '$agenticos:ask-brain'");
  assert.equal(askCommand(p, "codex", { hosts: { codex: { enabled: true, install: "direct" } } }), "codex '$ask-brain'");
  assert.equal(askCommand(p, "claude", null), "claude '/agenticos:ask-brain'");
});

test("state and reactions: setFlag round-trips the runtime shape; last vote wins; corrupt input is tolerated", () => {
  const t = setFlag(null, ["a", "b"], "read", true);
  assert.deepEqual(JSON.parse(t), { schema: 1, items: { a: { read: true }, b: { read: true } } });
  const t2 = setFlag(t, ["a"], "read", false);
  assert.deepEqual(parseState(t2), { b: { read: true } });
  assert.deepEqual(parseState("{not json"), {});
  const r = parseReactions('{"schema":1,"id":"i","ref":"s","value":1}\nbroken\n{"schema":1,"id":"i","ref":"s","value":-1}\n');
  assert.deepEqual(r, { "i|s": -1 });
  assert.equal(ago("2026-09-24T07:00:00Z", new Date("2026-09-24T09:30:00Z")), "2h ago");
  assert.equal(ago("2026-09-01T07:00:00Z", new Date("2026-09-24T09:30:00Z")), "2026-09-01");
});

function memAdapter(seed: Record<string, string> = {}): NotificationAdapter & { files: Record<string, string>; dirs: Set<string>; writes: number } {
  const files = { ...seed };
  const dirs = new Set<string>();
  const a = {
    files, dirs, writes: 0,
    exists: async (p: string) => p in files || dirs.has(p),
    read: async (p: string) => { if (!(p in files)) throw new Error(`ENOENT ${p}`); return files[p]; },
    write: async (p: string, d: string) => { a.writes++; files[p] = d; },
    mkdir: async (p: string) => { dirs.add(p); },
  };
  return a;
}

test("the writer re-reads state.json, skips no-op writes, and appends reactions the runtime can read", async () => {
  const a = memAdapter({ [STATE_PATH]: JSON.stringify({ schema: 1, items: { x: { archived: true } } }) });
  await setFlags(a, ["y"], "read", true);
  assert.deepEqual(parseState(a.files[STATE_PATH]), { x: { archived: true }, y: { read: true } });
  const n = a.writes;
  await setFlags(a, ["y"], "read", true);
  assert.equal(a.writes, n, "no change, no write");
  const fresh = memAdapter();
  await appendReaction(fresh, "i", "s", 1, new Date("2026-09-24T10:00:00Z"));
  await appendReaction(fresh, "i", "s", -1, new Date("2026-09-24T10:01:00Z"));
  assert.ok(fresh.dirs.has(NOTIFICATIONS_DIR));
  assert.equal(fresh.files[REACTIONS_PATH].trim().split("\n").length, 2);
  assert.deepEqual(parseReactions(fresh.files[REACTIONS_PATH]), { "i|s": -1 });
});
