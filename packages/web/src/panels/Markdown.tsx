/**
 * Markdown rendering with `marked`, a small allowlist sanitizer (docs are agent-written and may quote
 * the web), and link resolution: relative links like `../sources/gcb-2025-essd.md` open the matching doc.
 */
import { marked } from "marked";
import { useMemo } from "react";
import type { Doc } from "@muster-town/schema";
import { api } from "../api";
import { store } from "../state";

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
  return root.innerHTML;
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

export function Markdown({ text, className, breaks = false }: { text: string; className?: string; breaks?: boolean }) {
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
        e.preventDefault();
        if (href.startsWith("#")) return;
        void openDocLink(href);
      }}
    />
  );
}
