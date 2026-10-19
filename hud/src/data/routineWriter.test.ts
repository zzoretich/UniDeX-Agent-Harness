import { test } from "node:test";
import assert from "node:assert/strict";
import { writeRoutine, setRoutineEnabled, deleteRoutine, isGuardedChange, GuardedRoutineError, RoutineAdapter, RoutineDraft } from "./routineWriter";
import { routineFromFile } from "./routines";

function memAdapter(seed: Record<string, string> = {}): RoutineAdapter & { files: Record<string, string>; dirs: Set<string> } {
  const files = { ...seed }; const dirs = new Set<string>(Object.keys(seed).length ? ["brain/routines"] : []);
  return {
    files, dirs,
    exists: async (p) => p in files || dirs.has(p),
    read: async (p) => { if (!(p in files)) throw new Error(`ENOENT ${p}`); return files[p]; },
    write: async (p, d) => { files[p] = d; },
    mkdir: async (p) => { dirs.add(p); },
    remove: async (p) => { delete files[p]; },
  };
}
const duty = "---\nschema: 1\nname: Monitor\nkind: duty\nschedule: \"0 13 * * *\"\nenabled: true\nguarded: true\n---\nnote\n";
const draft = (over: Partial<RoutineDraft> = {}): RoutineDraft => ({ slug: "monitor", schema: 1, name: "Monitor", kind: "duty", schedule: "0 13 * * *", enabled: true, guarded: true, body: "note", ...over });

test("writeRoutine creates the folder and the file, refuses invalid drafts and silent overwrites", async () => {
  const a = memAdapter();
  const p = await writeRoutine(a, draft({ slug: "brief", kind: "prompt", guarded: false, body: "Write it." }));
  assert.equal(p, "brain/routines/brief.md");
  assert.ok(a.dirs.has("brain/routines"));
  assert.match(a.files[p], /^---\nschema: 1\nname: Monitor\nkind: prompt\nschedule: "0 13 \* \* \*"\nenabled: true\nguarded: false\n---\n\nWrite it\.\n$/);
  await assert.rejects(() => writeRoutine(a, draft({ slug: "brief", kind: "prompt", body: "" })), /needs a body/);
  await assert.rejects(() => writeRoutine(a, draft({ slug: "brief", kind: "prompt", body: "again" })), /already exists/);
  await writeRoutine(a, draft({ slug: "brief", kind: "prompt", guarded: false, body: "again" }), { overwrite: true });
  assert.match(a.files[p], /again/);
});

test("a guarded routine's schedule or body change needs confirmed: true; enable/disable never does", async () => {
  const a = memAdapter({ "brain/routines/monitor.md": duty });
  await assert.rejects(() => writeRoutine(a, draft({ schedule: "0 14 * * *" }), { overwrite: true }), GuardedRoutineError);
  await assert.rejects(() => writeRoutine(a, draft({ body: "changed" }), { overwrite: true }), GuardedRoutineError);
  assert.match(a.files["brain/routines/monitor.md"], /0 13/, "nothing written");
  await writeRoutine(a, draft({ schedule: "0 14 * * *" }), { overwrite: true, confirmed: true });
  assert.match(a.files["brain/routines/monitor.md"], /0 14/);
  // Same fields, only `enabled` differs: not a guarded change.
  await writeRoutine(a, draft({ schedule: "0 14 * * *", enabled: false }), { overwrite: true });
  assert.match(a.files["brain/routines/monitor.md"], /enabled: false/);
  const r = await setRoutineEnabled(a, "monitor", true);
  assert.equal(r.enabled, true);
  assert.equal(r.guarded, true);
  assert.equal(routineFromFile("monitor", a.files["brain/routines/monitor.md"]).body, "note\n");
});

test("isGuardedChange: only the contract fields, only for guarded files", () => {
  const before = routineFromFile("monitor", duty);
  assert.equal(isGuardedChange(null, draft()), false);
  assert.equal(isGuardedChange(before, draft()), false);
  assert.equal(isGuardedChange(before, draft({ name: "Renamed", tags: ["x"] })), false);
  assert.equal(isGuardedChange(before, draft({ schedule: "0 13 * * 1-5" })), true);
  assert.equal(isGuardedChange(before, draft({ body: "other" })), true);
  assert.equal(isGuardedChange({ ...before, guarded: false }, draft({ schedule: "0 1 * * *" })), false);
});

test("deleteRoutine: guarded needs confirmation; missing is a no-op", async () => {
  const a = memAdapter({ "brain/routines/monitor.md": duty });
  await assert.rejects(() => deleteRoutine(a, "monitor"), GuardedRoutineError);
  await deleteRoutine(a, "monitor", { confirmed: true });
  assert.ok(!("brain/routines/monitor.md" in a.files));
  await deleteRoutine(a, "monitor");
});
