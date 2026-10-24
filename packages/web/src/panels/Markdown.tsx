/**
 * Markdown rendering with `marked`, a small allowlist sanitizer (docs are agent-written and may quote
 * the web), and link resolution: relative links like `../sources/gcb-2025-essd.md` open the matching doc,
 * and bare doc ids (`dc_k955hun6c4`) in text become links.
 */
import { marked } from "marked";
import { useMemo } from "react";
import type { Doc } from "@muster-town/schema";
import { api } from "../api";
import { store } from "../state";
import { docUrl } from "../route";

const ALLOWED = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "A", "EM", "STRONG", "CODE", "PRE", "BLOCKQUOTE", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "HR", "BR", "DEL", "IMG", "INPUT", "SPAN", "DIV", "SUP", "SUB"]);
const ATTRS = new Set(["href", "title", "src", "alt", "align", "type", "checked", "disabled"]);

export function sanitize(html: string): string {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const walk = (el: Element) => {
    for (const child of [...el.children]) {
      if (!ALLOWED.has(child.tagName)) {
        if (["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "FORM", "LINK", "META"].includes(child.tagName)) child.remove();
        else child.replaceWith(...child.childNodes);
        continue;
      }
      for (const a of [...child.attributes]) {
        const v = a.value.trim().toLowerCase();
        if (!ATTRS.has(a.name) || ((a.name === "href" || a.name === "src") && /^(javascript|data|vbscript):/.test(v))) child.removeAttribute(a.name);
      }
      walk(child);
    }
  };
  const root = doc.body.firstElementChild!;
  walk(root);
  linkDocIds(root);
  return root.innerHTML;
}

/** A doc id as the server mints it: `dc_` + 10 lowercase alphanumerics. */
const DOC_ID_RE = /\bdc_[a-z0-9]{10}\b/g;

/** Split text into plain strings and `{ id }` parts at each bare doc id. */
export function docIdParts(s: string): (string | { id: string })[] {
  const out: (string | { id: string })[] = [];
  let last = 0;
  for (const m of s.matchAll(DOC_ID_RE)) {
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push({ id: m[0] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

/** The distinct doc ids cited in a text, in order of first mention. */
export const docIdsIn = (s: string): string[] => [...new Set(s.match(DOC_ID_RE) ?? [])];

/** A doc id as a link, as `linkDocIds` produces it: opens in the panel, or in a new tab (`/#/doc/<id>`) so the current panel stays put. */
const docIdAnchor = (id: string, newTab?: boolean) => ({
  className: "doc-id", title: store.state.docs[id]?.title, href: newTab ? docUrl(id) : id, target: newTab ? "_blank" : undefined, rel: newTab ? "noopener noreferrer" : undefined,
});

/** Plain text (no markdown) with bare doc ids as links; `newTab` keeps the current panel, e.g. a live meeting. */
export function DocText({ text, newTab }: { text: string; newTab?: boolean }) {
  const parts = useMemo(() => docIdParts(text), [text]);
  return (
    <>
      {parts.map((p, i) => typeof p === "string" ? p : (
        <a key={i} {...docIdAnchor(p.id, newTab)} onClick={newTab ? undefined : (e) => { e.preventDefault(); void openDocLink(p.id); }}>{p.id}</a>
      ))}
    </>
  );
}

/** Wrap bare doc ids in text nodes (outside links and code) in `<a href="dc_…">` so they open the doc. */
function linkDocIds(root: Element) {
  const owner = root.ownerDocument;
  const texts: Text[] = [];
  const it = owner.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = it.nextNode(); n; n = it.nextNode()) {
    if (!n.parentElement?.closest("a, code, pre") && (n.nodeValue ?? "").includes("dc_")) texts.push(n as Text);
  }
  for (const t of texts) {
    const parts = docIdParts(t.nodeValue ?? "");
    if (parts.every((p) => typeof p === "string")) continue;
    t.replaceWith(...parts.map((p) => {
      if (typeof p === "string") return p;
      const a = owner.createElement("a");
      a.setAttribute("href", p.id);
      a.className = "doc-id";
      const title = store.state.docs[p.id]?.title;
      if (title) a.title = title;
      a.textContent = p.id;
      return a;
    }));
  }
}

const slug = (s: string) => s.toLowerCase().replace(/\.md$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Find the doc a relative link points at: by id, by tag, by slug of the title, or by export filename `<slug>-<id8>`. */
export function matchDoc(href: string, docs: Doc[]): Doc | null {
  const clean = decodeURIComponent(href.split("#")[0].split("?")[0]);
  const base = clean.split("/").filter(Boolean).pop() ?? "";
  if (!base) return null;
  const byId = docs.find((d) => d.id === base || d.id === clean.replace(/^doc:/, ""));
  if (byId) return byId;
  const s = slug(base);
  return docs.find((d) => d.tags.some((t) => slug(t) === s))
    ?? docs.find((d) => slug(d.title) === s)
    ?? docs.find((d) => s.endsWith(d.id.slice(-8).toLowerCase()) && s.length > 8)
    ?? null;
}

export async function openDocLink(href: string) {
  let hit = matchDoc(href, Object.values(store.state.docs));
  const id = /^(?:doc:)?(dc_[a-z0-9_]+)$/.exec(href.split("/").pop() ?? "")?.[1];
  if (!hit && id) {
    try { hit = await api().doc(id); store.putDocs([hit]); } catch { /* not visible or not an id: try the other ways */ }
  }
  if (!hit) {
    try {
      const list = await api().docs({ limit: 200 });
      store.putDocs(list);
      hit = matchDoc(href, list);
      if (!hit) {
        const base = slug(href.split("/").pop() ?? "").replace(/-/g, " ");
        const found = await api().docs({ q: base, limit: 5 });
        hit = found[0] ?? null;
      }
    } catch { /* fall through */ }
  }
  if (hit) store.open({ kind: "library", docId: hit.id });
  else store.toast(`No document found for ${href}`, "bad");
}

/** Unsanitized HTML; `breaks` turns a single newline into a line break, for chat text where people press Enter and mean it. */
export const markdownHtml = (text: string, breaks = false) => marked.parse(text, { async: false, gfm: true, breaks }) as string;

/** `newTab`: doc links open as `/#/doc/<id>` in a new tab instead of replacing the current panel (used inside a live meeting). */
export function Markdown({ text, className, breaks = false, newTab = false }: { text: string; className?: string; breaks?: boolean; newTab?: boolean }) {
  const html = useMemo(() => sanitize(markdownHtml(text, breaks)), [text, breaks]);
  return (
    <div
      className={`md ${className ?? ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest("a");
        if (!a) return;
        const href = a.getAttribute("href") ?? "";
        if (/^(https?:|mailto:)/i.test(href)) { a.target = "_blank"; a.rel = "noopener noreferrer"; return; }
        if (href.startsWith("#")) { e.preventDefault(); return; }
        const id = /^(?:doc:)?(dc_[a-z0-9]{10})$/.exec(href.split("/").pop() ?? "")?.[1];
        if (newTab && id) { a.href = docUrl(id); a.target = "_blank"; a.rel = "noopener noreferrer"; return; }
        e.preventDefault();
        void openDocLink(href);
      }}
    />
  );
}
