// todoWriter.ts — writes <vault>/TODO.md for the To-Do tab (spec 2026-09-22-todo-and-proposals-tabs §4.3).
// TODO.md has two writers (this tab and the /todo command), so the tab never writes back a copy it
// cached: every change re-reads the file, applies one pure edit from todos.ts, and writes the result.
// An edit that names a line which is no longer there throws StaleTodoError and writes nothing.
// The IO goes through a tiny adapter (the routineWriter shape) so tests stub it without "obsidian".
import type { App } from "obsidian";
import { TODO_PATH } from "./todos";

export interface TodoAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
}

export function adapterOf(app: App): TodoAdapter {
  const a = app.vault.adapter;
  return { exists: (p) => a.exists(p), read: (p) => a.read(p), write: (p, d) => a.write(p, d) };
}

/** TODO.md's current text, or null when it does not exist yet. */
export async function readTodoFile(adapter: TodoAdapter): Promise<string | null> {
  return (await adapter.exists(TODO_PATH)) ? adapter.read(TODO_PATH) : null;
}

/** Re-reads TODO.md, applies `edit` (a todos.ts function) and writes the result; returns the new text. */
export async function applyTodoEdit(adapter: TodoAdapter, edit: (text: string | null) => string): Promise<string> {
  const before = await readTodoFile(adapter);
  const after = edit(before);          // throws StaleTodoError before anything is written
  if (after !== before) await adapter.write(TODO_PATH, after);
  return after;
}
