import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import {
  TODO_TEMPLATE, StaleTodoError, parseTodos, parseBody, composeBody, withPriority, withDue, addTodo, toggleTodo,
  editTodo, removeTodo, groupTodos, doneThisWeek, openTags, todoBadgeCount, localDay, addDays,
} from "./todos";

const FILE = `# To-Do

Some prose the owner wrote.

## Open
- [ ] Renew passport ⏫ 📅 2026-09-20 #personal
- [ ] Ship proposals tab #agenticos-workbench
  - [ ] a sub-step that travels with it
  notes line
- [ ] Call dentist 🔽 📅 2026-09-22
- [ ] Pay rent 🔺 📅 2026-09-22 #home
- [ ] Book flights 📅 2026-10-03 #trip ⏳ 2026-09-30
- [ ] Unranked today 📅 2026-09-22

## Someday list
- [ ] Learn the cello 🔼

## Done
- [x] Fix upgrade re-exec ✅ 2026-09-21
- [x] Old thing ✅ 2026-09-01
- [x] Undated done
`;
const TODAY = "2026-09-22";

test("parseTodos reads every top-level item with its tokens, section and children", () => {
  const items = parseTodos(FILE);
  assert.equal(items.length, 10);
  const passport = items[0];
  assert.deepEqual(
    { text: passport.text, due: passport.due, priority: passport.priority, tags: passport.tags, section: passport.section, done: passport.done },
    { text: "Renew passport", due: "2026-09-20", priority: "high", tags: ["personal"], section: "Open", done: false },
  );
  assert.deepEqual(items[1].children, ["  - [ ] a sub-step that travels with it", "  notes line"]);
  assert.equal(items[4].text, "Book flights ⏳ 2026-09-30", "unknown Tasks tokens stay in the text");
  assert.equal(items[6].section, "Someday list");
  assert.equal(items[7].doneOn, "2026-09-21");
  assert.equal(items[9].doneOn, null);
});

test("parseBody ignores numeric-only hashes and handles the variation selector", () => {
  assert.deepEqual(parseBody("Fix issue #42 for #team-a"), { text: "Fix issue #42 for", due: null, doneOn: null, priority: null, tags: ["team-a"] });
  assert.equal(parseBody("Due 📅️ 2026-09-30").due, "2026-09-30");
});

test("composeBody, withPriority and withDue keep Tasks order", () => {
  assert.equal(composeBody({ text: "Renew passport", priority: "high", due: "2026-10-01", tags: ["personal"] }), "Renew passport ⏫ 📅 2026-10-01 #personal");
  assert.equal(composeBody({ text: "Plain" }), "Plain");
  assert.equal(withPriority("Renew passport 📅 2026-10-01 #personal", "high"), "Renew passport ⏫ 📅 2026-10-01 #personal");
  assert.equal(withPriority("Renew passport ⏫ 📅 2026-10-01", "low"), "Renew passport 🔽 📅 2026-10-01");
  assert.equal(withPriority("Renew passport ⏫", null), "Renew passport");
  assert.equal(withDue("Renew passport ⏫ #personal #urgent", "2026-10-01"), "Renew passport ⏫ 📅 2026-10-01 #personal #urgent");
  assert.equal(withDue("Renew passport ⏫ 📅 2026-10-01", "2026-11-01"), "Renew passport ⏫ 📅 2026-11-01");
  assert.equal(withDue("Renew passport 📅 2026-10-01 #x", null), "Renew passport #x");
});

test("addTodo appends to the end of ## Open, after the last item's children, and creates the file from the template", () => {
  const out = addTodo(FILE, "New thing #x");
  const lines = out.split("\n");
  assert.equal(lines[lines.indexOf("- [ ] Unranked today 📅 2026-09-22") + 1], "- [ ] New thing #x");
  const fresh = addTodo(null, "First");
  assert.equal(fresh, TODO_TEMPLATE.replace("## Open\n", "## Open\n- [ ] First\n"));
  assert.equal(addTodo("", "First"), fresh);
  assert.equal(addTodo("# Mine\n", "x"), "# Mine\n\n## Open\n- [ ] x\n", "a file without ## Open gains one");
  assert.throws(() => addTodo(FILE, "  \n "), /empty todo/);
});

test("the template is what the vault seed ships", () => {
  const seed = fs.readFileSync(path.resolve(__dirname, "../../../vault-template/TODO.md"), "utf8");
  assert.equal(seed, TODO_TEMPLATE);
});

test("toggleTodo ticks into the top of ## Done with the date, children included; un-ticking returns it to ## Open", () => {
  const ticked = toggleTodo(FILE, "- [ ] Ship proposals tab #agenticos-workbench", TODAY);
  const lines = ticked.split("\n");
  const done = lines.indexOf("## Done");
  assert.deepEqual(lines.slice(done + 1, done + 4), [
    "- [x] Ship proposals tab #agenticos-workbench ✅ 2026-09-22",
    "  - [ ] a sub-step that travels with it",
    "  notes line",
  ]);
  assert.equal(ticked.includes("- [ ] Ship proposals tab"), false);
  const back = toggleTodo(ticked, "- [x] Ship proposals tab #agenticos-workbench ✅ 2026-09-22", TODAY);
  const b = back.split("\n");
  const at = b.indexOf("- [ ] Ship proposals tab #agenticos-workbench");
  assert.ok(at > b.indexOf("- [ ] Unranked today 📅 2026-09-22") && at < b.indexOf("## Someday list"));
  assert.equal(b[at + 1], "  - [ ] a sub-step that travels with it");
});

test("a line that changed underneath is refused, never guessed", () => {
  assert.throws(() => toggleTodo(FILE, "- [ ] Renew passport", TODAY), StaleTodoError);
  assert.throws(() => editTodo(FILE, "- [ ] gone", "x"), StaleTodoError);
  assert.throws(() => removeTodo(FILE, "Some prose the owner wrote."), StaleTodoError, "only item lines are addressable");
});

test("editTodo keeps the checkbox and children; removeTodo drops the block; untouched lines survive byte for byte", () => {
  const edited = editTodo(FILE, "- [ ] Ship proposals tab #agenticos-workbench", "Ship the proposals tab ⏫ #agenticos-workbench");
  assert.equal(edited, FILE.replace("- [ ] Ship proposals tab #agenticos-workbench", "- [ ] Ship the proposals tab ⏫ #agenticos-workbench"));
  const removed = removeTodo(FILE, "- [ ] Ship proposals tab #agenticos-workbench");
  assert.equal(removed, FILE.replace("- [ ] Ship proposals tab #agenticos-workbench\n  - [ ] a sub-step that travels with it\n  notes line\n", ""));
  assert.equal(removeTodo(addTodo(FILE, "tmp"), "- [ ] tmp"), FILE);
});

test("groupTodos buckets open items by due date and sorts by Tasks priority rank", () => {
  const g = groupTodos(parseTodos(FILE), TODAY);
  assert.deepEqual(g.overdue.map((t) => t.text), ["Renew passport"]);
  assert.deepEqual(g.today.map((t) => t.text), ["Pay rent", "Unranked today", "Call dentist"], "highest, none, low");
  assert.deepEqual(g.upcoming.map((t) => t.text), ["Book flights ⏳ 2026-09-30"]);
  assert.deepEqual(g.someday.map((t) => t.text), ["Learn the cello", "Ship proposals tab"], "medium before none");
});

test("doneThisWeek, openTags and the badge count", () => {
  const items = parseTodos(FILE);
  assert.deepEqual(doneThisWeek(items, TODAY).map((t) => t.text), ["Fix upgrade re-exec"]);
  assert.deepEqual(doneThisWeek(items, "2026-09-07").map((t) => t.text), ["Old thing"]);
  assert.deepEqual(openTags(items), ["agenticos-workbench", "home", "personal", "trip"]);
  assert.equal(todoBadgeCount(FILE, TODAY), 4, "1 overdue + 3 today");
  assert.equal(todoBadgeCount(null, TODAY), 0);
});

test("localDay and addDays use the local calendar", () => {
  assert.equal(localDay(new Date(2026, 8, 22, 23, 59)), "2026-09-22");
  assert.equal(addDays("2026-09-22", -6), "2026-09-16");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});
