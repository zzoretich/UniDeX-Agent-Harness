import { test } from "node:test";
import assert from "node:assert/strict";
import { TodoAdapter, applyTodoEdit, readTodoFile } from "./todoWriter";
import { TODO_PATH, TODO_TEMPLATE, StaleTodoError, addTodo, toggleTodo } from "./todos";

function memAdapter(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const writes: string[] = [];
  const adapter: TodoAdapter = {
    exists: async (p) => files.has(p),
    read: async (p) => { const v = files.get(p); if (v === undefined) throw new Error("ENOENT"); return v; },
    write: async (p, d) => { writes.push(p); files.set(p, d); },
  };
  return { adapter, files, writes };
}

test("a missing TODO.md reads as null and the first add creates it from the template", async () => {
  const m = memAdapter();
  assert.equal(await readTodoFile(m.adapter), null);
  const out = await applyTodoEdit(m.adapter, (t) => addTodo(t, "First ⏫"));
  assert.equal(out, TODO_TEMPLATE.replace("## Open\n", "## Open\n- [ ] First ⏫\n"));
  assert.equal(m.files.get(TODO_PATH), out);
  assert.deepEqual(m.writes, [TODO_PATH]);
});

test("every edit re-reads the file, so a line added elsewhere is kept", async () => {
  const m = memAdapter({ [TODO_PATH]: addTodo(null, "Mine") });
  // Another writer (the /todo command) appends between the tab's render and its click.
  m.files.set(TODO_PATH, addTodo(m.files.get(TODO_PATH)!, "Added by /todo"));
  const out = await applyTodoEdit(m.adapter, (t) => toggleTodo(t!, "- [ ] Mine", "2026-09-22"));
  assert.match(out, /- \[ \] Added by \/todo/);
  assert.match(out, /- \[x\] Mine ✅ 2026-09-22/);
});

test("a stale line throws and writes nothing", async () => {
  const text = addTodo(null, "Mine");
  const m = memAdapter({ [TODO_PATH]: text });
  await assert.rejects(applyTodoEdit(m.adapter, (t) => toggleTodo(t!, "- [ ] Edited elsewhere", "2026-09-22")), StaleTodoError);
  assert.deepEqual(m.writes, []);
  assert.equal(m.files.get(TODO_PATH), text);
});

test("an edit that changes nothing does not write", async () => {
  const m = memAdapter({ [TODO_PATH]: "x\n" });
  await applyTodoEdit(m.adapter, (t) => t!);
  assert.deepEqual(m.writes, []);
});
