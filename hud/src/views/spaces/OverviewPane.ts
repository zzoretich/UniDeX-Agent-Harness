// OverviewPane.ts — the dossier's Overview (spaces-redesign D8): Summary with its source, Objectives with "n of m", a
// progressbar and the checklist, Documents (handoffs and plans with age and a one-line note, finished ones marked done).
// Typographic sections, no boxed panels. A collection keeps today's subproject list.
import type { WorkspaceEntry } from "../../data/snapshot";
import { overviewFor } from "../../data/spacesModel";
import { button, sectionHead, verbsOff, type SpacesCtx } from "./ui";

export function renderOverview(host: HTMLElement, ctx: SpacesCtx, e: WorkspaceEntry): void {
  const o = overviewFor(e, { now: ctx.now });

  const sum = host.createEl("section", { cls: "aos-spc-sec", attr: { "aria-label": "Summary" } });
  const sh = sectionHead(sum, "SUMMARY");
  if (o.summary.text) {
    if (o.summary.template) sh.createSpan({ cls: "aos-spc-src", text: "the stub's placeholder: write a summary in workspace.md" });
    else if (o.summary.source) sh.createSpan({ cls: "aos-spc-src", text: o.summary.source });
    sum.createEl("p", { cls: `aos-spc-summary${o.summary.template ? " is-template" : ""}`, text: o.summary.text });
  } else sum.createEl("p", { cls: "aos-spc-emptyval", text: "No summary yet: add one to workspace.md or the README." });
  // A summary that is missing or only the stub's text offers the draft (spaces-redesign D13, D23): a review dialog that
  // writes nothing until Save.
  if ((!o.summary.text || o.summary.template) && !verbsOff(e, ctx.world)) {
    sh.createSpan({ cls: "aos-spc-grow" });
    const d = button(sh, "aos-spc-linkbtn aos-spc-draftlink", "Draft workspace.md…", { key: "draft-summary", title: "A summary, objectives and next step from the folder's own files, for review" });
    d.addEventListener("click", () => ctx.act.draft());
  }

  const obj = host.createEl("section", { cls: "aos-spc-sec", attr: { "aria-label": "Objectives" } });
  const oh = sectionHead(obj, "OBJECTIVES");
  if (o.objectives.total) {
    oh.createSpan({ cls: "aos-spc-mono aos-spc-objcount", text: o.objectives.label });
    const bar = oh.createSpan({
      cls: "aos-spc-progress",
      attr: {
        role: "progressbar", "aria-label": "Objectives done", "aria-valuemin": "0", "aria-valuemax": "100",
        "aria-valuenow": String(o.objectives.pct), "aria-valuetext": `${o.objectives.label} done`,
      },
    });
    bar.createSpan({ cls: "aos-spc-progressfill" }).style.width = `${o.objectives.pct}%`;
    const list = obj.createEl("ul", { cls: "aos-spc-objectives" });
    for (const it of o.objectives.items) {
      const li = list.createEl("li", { cls: `aos-spc-obj${it.done ? " is-done" : ""}` });
      const box = li.createSpan({ cls: "aos-spc-check", attr: { role: "img", "aria-label": it.done ? "done" : "open" } });
      if (it.done) ctx.setIcon(box, "check");
      li.createSpan({ cls: "aos-spc-objtext", text: it.text });
    }
  } else obj.createEl("p", { cls: "aos-spc-emptyval", text: "No objectives yet: list them in workspace.md." });

  if (e.subprojects?.length) {
    const sp = host.createEl("section", { cls: "aos-spc-sec", attr: { "aria-label": "Subprojects" } });
    sectionHead(sp, "SUBPROJECTS").createSpan({ cls: "aos-spc-mono aos-spc-dim", text: String(e.subprojects.length) });
    for (const s of e.subprojects) {
      const b = button(sp, "aos-spc-docrow", null, { key: `sub:${s.path}`, title: `Open ${s.path}` });
      b.createSpan({ cls: "aos-spc-docname", text: s.name });
      b.createSpan({ cls: "aos-spc-docnote", text: s.summary ?? "" });
      b.createSpan({ cls: "aos-spc-docage", text: s.status ?? "" });
      b.addEventListener("click", () => ctx.act.openFile(s.path));
    }
  }

  const docs = host.createEl("section", { cls: "aos-spc-sec", attr: { "aria-label": "Documents" } });
  const dh = sectionHead(docs, "DOCUMENTS");
  if (o.docs.length) {
    dh.createSpan({ cls: "aos-spc-mono aos-spc-dim", text: String(o.docs.length) });
    for (const d of o.docs) {
      const b = button(docs, `aos-spc-docrow${d.done ? " is-done" : ""}`, null, { key: `doc:${d.path}`, title: `Open ${d.path}` });
      b.createSpan({ cls: "aos-spc-docname", text: d.name });
      const note = b.createSpan({ cls: "aos-spc-docnote" });
      if (d.done) note.createSpan({ cls: "aos-spc-done", text: "done" });
      if (d.done && d.note) note.appendText(" · ");
      if (d.note) note.appendText(d.note);
      b.createSpan({ cls: "aos-spc-docage", text: d.age });
      b.addEventListener("click", () => ctx.act.openFile(d.path));
    }
  } else docs.createEl("p", { cls: "aos-spc-emptyval", text: "No handoffs or plans here yet." });
}
