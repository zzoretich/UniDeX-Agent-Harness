// MarkdownRenderer: markdown-it with Obsidian's [[wiki-links]] and task checkboxes, sanitized by DOMPurify before it
// touches the DOM. Raw HTML in notes is escaped rather than rendered: notifications carry text from the web. Each block
// carries the line of the note it starts on (`data-line`, 1-based, frontmatter counted), so a note can open at a line.

import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import { bridge } from "./bridge";
import { Component } from "./events";
import { Notice } from "./notice";

interface LinkHost {
  workspace: {
    openLinkText(link: string, source: string, newLeaf?: boolean): Promise<void>;
    resolveLink(link: string, source?: string): { path: string } | null;
  };
  vault: { adapter: { getFullPath(path: string): string } };
}
let host: LinkHost | null = null;
/** The host app that internal links open through; set once at boot. */
export function setMarkdownHost(app: LinkHost): void { host = app; }

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

md.inline.ruler.before("link", "wikilink", (state, silent) => {
  const src = state.src;
  const embed = src.charCodeAt(state.pos) === 0x21; // "!"
  const start = embed ? state.pos + 1 : state.pos;
  if (src.slice(start, start + 2) !== "[[") return false;
  const end = src.indexOf("]]", start + 2);
  if (end < 0) return false;
  if (!silent) {
    const [target, alias] = src.slice(start + 2, end).split("|");
    const tok = state.push("wikilink", "", 0);
    tok.meta = { target: target.trim(), alias: (alias ?? "").trim(), embed };
  }
  state.pos = end + 2;
  return true;
});

md.renderer.rules.wikilink = (tokens, idx) => {
  const { target, alias } = tokens[idx].meta as { target: string; alias: string };
  const label = alias || target.replace(/#\^?/, " › ");
  return `<a class="internal-link" data-href="${md.utils.escapeHtml(target)}" href="#">${md.utils.escapeHtml(label)}</a>`;
};

// Every block's opening tag names the note line it starts on; `env.lineOffset` is how many lines the frontmatter took.
const LINE_BLOCKS = new Set(["fence", "code_block", "hr", "html_block"]);
md.core.ruler.push("source_lines", (state) => {
  const offset = (state.env as { lineOffset?: number } | undefined)?.lineOffset ?? 0;
  for (const t of state.tokens) {
    if (t.map && t.block && (t.nesting === 1 || LINE_BLOCKS.has(t.type))) t.attrSet("data-line", String(t.map[0] + offset + 1));
  }
});

function stripFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

/** A note as HTML, unsanitized, each block marked with the line it starts on in `markdown` (frontmatter included). */
export function renderHtml(markdown: string): string {
  const text = markdown ?? "";
  const body = stripFrontmatter(text);
  const lineOffset = text.slice(0, text.length - body.length).split("\n").length - 1;
  return md.render(body, { lineOffset });
}

/** The block a 1-based note `line` falls in: the last of `starts` (each block's first line, in reading order) at or
 *  before it, or null when the line is above every block. */
export function blockAtLine(starts: readonly number[], line: number): number | null {
  let best = -1;
  for (let i = 0; i < starts.length; i++) if (starts[i] <= line && (best < 0 || starts[i] >= starts[best])) best = i;
  return best < 0 ? null : best;
}

function taskify(root: DocumentFragment): void {
  for (const li of Array.from(root.querySelectorAll("li"))) {
    const first = li.firstChild?.nodeType === Node.TEXT_NODE ? li.firstChild : li.firstElementChild?.tagName === "P" ? li.firstElementChild.firstChild : null;
    if (!first || first.nodeType !== Node.TEXT_NODE) continue;
    const m = /^\[( |x|X)\]\s/.exec(first.textContent ?? "");
    if (!m) continue;
    first.textContent = (first.textContent ?? "").slice(m[0].length);
    const box = document.createElement("input");
    box.type = "checkbox";
    box.disabled = true;
    box.checked = m[1] !== " ";
    box.className = "task-list-item-checkbox";
    first.parentNode?.insertBefore(box, first);
    li.classList.add("task-list-item");
    if (box.checked) li.classList.add("is-checked");
  }
}

/** Obsidian treats a Markdown link with no scheme (`[Title](brain/memory/x.md)`) as a link into the vault. */
function markVaultLinks(root: DocumentFragment): void {
  for (const a of Array.from(root.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href") ?? "";
    if (a.classList.contains("internal-link") || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
    let target = href;
    try { target = decodeURIComponent(href); } catch { /* keep it as written */ }
    a.classList.add("internal-link");
    a.setAttribute("data-href", target);
    a.setAttribute("href", "#");
  }
}

/** Vault files a note shows only as source: a web page, a PDF, an image. */
const OPENS_OUTSIDE = new Set(["html", "htm", "pdf", "png", "jpg", "jpeg", "gif", "webp", "svg"]);

/** Whether a vault link opens with the file's default app rather than in a note (`brain/_index/brief.html#top` → true). */
export function opensOutside(linktext: string): boolean {
  const target = linktext.split("|")[0].split("#")[0].trim();
  const ext = /\.([a-z0-9]+)$/i.exec(target)?.[1].toLowerCase();
  return ext !== undefined && OPENS_OUTSIDE.has(ext);
}

/** Main decides what may open (shell policy): a page only from brain/_index, anything it will not open is shown in Finder. */
async function openOutside(app: LinkHost, linktext: string, sourcePath: string): Promise<void> {
  const file = app.workspace.resolveLink(linktext, sourcePath);
  if (!file) { new Notice(`Cannot find "${linktext}" in the vault`); return; }
  const err = await bridge().shell.openPath(app.vault.adapter.getFullPath(file.path));
  if (err) new Notice(`Cannot open ${file.path}: ${err}`);
}

function wireLinks(root: HTMLElement, sourcePath: string): void {
  root.addEventListener("click", (ev) => {
    const a = (ev.target as HTMLElement).closest("a");
    if (!a || !root.contains(a)) return;
    ev.preventDefault();
    if (a.classList.contains("internal-link")) {
      const target = a.getAttribute("data-href") ?? "";
      if (host && opensOutside(target)) { void openOutside(host, target, sourcePath); return; }
      void host?.workspace.openLinkText(target, sourcePath, ev.metaKey || ev.ctrlKey);
      return;
    }
    const href = a.getAttribute("href") ?? "";
    // The main process decides what may open externally (an https allow-list); window.open is how we ask it.
    if (/^https?:\/\//i.test(href)) window.open(href);
  });
}

function renderInto(markdown: string, el: HTMLElement, sourcePath: string): void {
  const html = renderHtml(markdown);
  const frag = DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true }) as DocumentFragment;
  taskify(frag);
  markVaultLinks(frag);
  el.classList.add("markdown-rendered");
  el.appendChild(frag);
  if (!(el as HTMLElement & { __aosLinks?: boolean }).__aosLinks) {
    (el as HTMLElement & { __aosLinks?: boolean }).__aosLinks = true;
    wireLinks(el, sourcePath);
  }
}

export class MarkdownRenderer extends Component {
  static async renderMarkdown(markdown: string, el: HTMLElement, sourcePath: string, _component?: Component): Promise<void> {
    renderInto(markdown, el, sourcePath);
  }

  static async render(_app: unknown, markdown: string, el: HTMLElement, sourcePath: string, _component?: Component): Promise<void> {
    renderInto(markdown, el, sourcePath);
  }
}
