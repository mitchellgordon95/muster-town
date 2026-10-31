/**
 * Markdown rendering with `marked`, a small allowlist sanitizer (docs are agent-written and may quote
 * the web), and link resolution: relative links like `../sources/gcb-2025-essd.md` open the matching doc,
 * and bare ids in text become links (see LINK_KINDS): a doc opens in the library panel, a grant or proposal in the grant
 * panel, a meeting, agent or building in its panel, a key result in the goal tree, media as its file. Names label them
 * where the client knows them ("Teo 1", "UI / UX", a meeting's title, a key result's text).
 */
import { marked } from "marked";
import { useEffect, useMemo, useState } from "react";
import type { Doc, GoalTreeNode } from "@muster-town/schema";
import { api, API_BASE } from "../api";
import { store, useTown } from "../state";
import { docUrl, grantUrl } from "../route";

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
        // media is cited as `/api/media/…`: in a hosted collective that is its own `/<slug>/api/media/…`
        else if ((a.name === "href" || a.name === "src") && API_BASE && a.value.startsWith("/api/media/")) child.setAttribute(a.name, API_BASE + a.value);
      }
      walk(child);
    }
  };
  const root = doc.body.firstElementChild!;
  walk(root);
  inlineMedia(root);
  linkDocIds(root);
  return root.innerHTML;
}

/** An image whose src is a video file (`![demo](/api/media/mf_….webm)`, docs/multimedia.md) plays inline; images open full size on click. */
const VIDEO_SRC_RE = /\.(webm|mp4)(\?.*)?$/i;
function inlineMedia(root: Element) {
  const owner = root.ownerDocument;
  for (const img of [...root.querySelectorAll("img")]) {
    const src = img.getAttribute("src") ?? "";
    if (!src) continue;
    if (VIDEO_SRC_RE.test(src)) {
      const v = owner.createElement("video");
      v.setAttribute("src", src);
      v.setAttribute("controls", "");
      v.setAttribute("preload", "metadata");
      v.setAttribute("playsinline", "");
      v.className = "md-media";
      const alt = img.getAttribute("alt");
      if (alt) v.setAttribute("title", alt);
      img.replaceWith(v);
    } else {
      img.setAttribute("loading", "lazy");
      img.className = "md-media";
      if (!img.closest("a")) {
        const a = owner.createElement("a");
        a.setAttribute("href", src);
        a.className = "md-media-link";
        img.replaceWith(a);
        a.append(img);
      }
    }
  }
}

/**
 * The ids that open something (kr_utx7pmv1yk "No dead ids"): a doc (library), a grant or proposal (grant panel), a meeting
 * (meeting panel), an agent, a building, a key result (the goal tree at its goal, the key result highlighted) and an uploaded
 * picture or video (`mf_`: the file itself), an assignment (its card) and a session (its panel). Each is the prefix + 10
 * lowercase alphanumerics, as the server mints them.
 */
const LINK_KINDS = ["dc", "gr", "mt", "ag", "bl", "kr", "mf", "as", "se"] as const;
const LINK_ID_RE = new RegExp(`\\b(?:${LINK_KINDS.join("|")})_[a-z0-9]{10}\\b`, "g");
/** A doc id alone, for places that want docs only (the say-box preview by title). */
const DOC_ID_RE = /\bdc_[a-z0-9]{10}\b/g;
/** The id a link target names, bare or `doc:`-prefixed, with any path in front (media links are plain URLs and open as files). */
const LINK_TARGET_RE = /^(?:doc:)?((?:dc|gr|mt|ag|bl|kr|as|se)_[a-z0-9]{10})$/;

export const isGrantId = (id: string) => id.startsWith("gr_");
/** Ids with a shareable hash URL (`/#/doc/<id>`, `/#/grant/<id>`, `/#/meeting/<id>`, …): every linkable id but media, which is its own URL. */
const hasHash = (id: string) => !id.startsWith("mf_");

/** Split text into plain strings and `{ id }` parts at each linkable id (doc, grant, meeting, agent, building, key result, media). */
export function docIdParts(s: string): (string | { id: string })[] {
  const out: (string | { id: string })[] = [];
  let last = 0;
  for (const m of s.matchAll(LINK_ID_RE)) {
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push({ id: m[0] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

/** The distinct doc ids cited in a text, in order of first mention. */
export const docIdsIn = (s: string): string[] => [...new Set(s.match(DOC_ID_RE) ?? [])];

/** Key result texts by id, for labelling kr_ links; filled from GET /api/goals the first time a text cites a key result. */
const krTexts = new Map<string, string>();
let krLoad: Promise<void> | null = null;
const krListeners = new Set<() => void>();
function loadKrTexts(): Promise<void> {
  krLoad ??= api().goalTree().then((root) => {
    const walk = (n: GoalTreeNode) => { for (const k of n.keyResults) krTexts.set(k.id, k.text); n.children.forEach(walk); };
    walk(root);
    for (const f of krListeners) f();
  }, () => undefined);
  return krLoad;
}
/** Assignment titles by id, for labelling as_ links: the store's assignments first, else fetched (GET /api/assignments/:id) once per id a text cites. */
const asTitles = new Map<string, string>();
const asAsked = new Set<string>();
const AS_ID_RE = /\bas_[a-z0-9]{10}\b/g;
/** An assignment card that loaded tells the labels its title. */
export function rememberAssignmentTitle(id: string, title: string) {
  if (asTitles.get(id) === title) return;
  asTitles.set(id, title);
  for (const f of krListeners) f();
}
function loadAssignmentTitles(text: string) {
  const want = [...new Set(text.match(AS_ID_RE) ?? [])].filter((id) => !asAsked.has(id) && !asTitles.has(id) && !store.state.assignments[id]);
  for (const id of want) {
    asAsked.add(id);
    api().assignmentCard(id).then((a) => rememberAssignmentTitle(id, a.title), () => undefined);
  }
}

/** Re-renders once the key result texts arrive when `text` cites one (and, for any text, as agents and buildings load), so its links get their names. */
function useIdLabels(text: string): number {
  const [kr, setKr] = useState(0);
  const cites = text.includes("kr_");
  const citesAs = text.includes("as_");
  useEffect(() => {
    if (!cites && !citesAs) return;
    const f = () => setKr((n) => n + 1);
    krListeners.add(f);
    if (cites) void loadKrTexts();
    if (citesAs) loadAssignmentTitles(text);
    return () => { krListeners.delete(f); };
  }, [cites, citesAs, text]);
  const known = useTown((s) => s.buildings.length + Object.keys(s.agents).length + Object.keys(s.meetings).length);
  return kr * 100000 + known;
}

const clipLabel = (s: string, n = 48) => s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;

/** What a reader sees for an id: the agent's, building's or meeting's name, a key result's text (clipped), else the id itself. Docs and grants keep their id (a doc's title is its tooltip). */
export function idLabel(id: string): string | null {
  const s = store.state;
  switch (id.slice(0, 2)) {
    case "ag": return s.agents[id]?.name ?? store.names.get(id) ?? null;
    case "bl": return s.buildings.find((b) => b.id === id)?.name ?? null;
    case "mt": return s.meetings[id]?.title ?? null;
    case "kr": { const t = krTexts.get(id); return t ? clipLabel(t) : null; }
    case "as": { const t = s.assignments[id]?.title ?? asTitles.get(id); return t ? clipLabel(t) : null; }
    default: return null;
  }
}

/** The tooltip of an id link: what it opens, and the id when the label is a name. */
function idTitle(id: string, label: string | null): string | undefined {
  const what: Record<string, string> = { gr: "grant", mt: "meeting", ag: "agent", bl: "building", kr: "key result", mf: "picture or video: opens the file", as: "assignment", se: "session" };
  if (id.startsWith("dc_")) return store.state.docs[id]?.title;
  if (id.startsWith("kr_") && krTexts.get(id)) return `key result ${id}: ${krTexts.get(id)}`;
  if (id.startsWith("as_") && label) return `assignment ${id}: ${store.state.assignments[id]?.title ?? asTitles.get(id)}`;
  return label ? `${what[id.slice(0, 2)]} ${id}` : what[id.slice(0, 2)];
}

/** The shareable URL of an id (`/#/doc/<id>`, `/#/grant/<id>`, `/#/meeting/<id>`, `/#/agent/<id>`, `/#/building/<id>`, `/#/kr/<id>`), or the media file. */
const KIND_HASH: Record<string, string> = { dc: "doc", gr: "grant", mt: "meeting", ag: "agent", bl: "building", kr: "kr", as: "assignment", se: "session" };
const urlOf = (id: string) => id.startsWith("gr_") ? grantUrl(id) : id.startsWith("dc_") ? docUrl(id) : hasHash(id) ? `${location.origin}${location.pathname}#/${KIND_HASH[id.slice(0, 2)]}/${id}` : mediaUrl(id);
const mediaUrl = (id: string) => `${API_BASE}/api/media/${id}`;

/** Open what an id names in its panel: a grant, a meeting, an agent, a building, a key result in the goal tree, else a doc in the library. */
export function openIdLink(id: string) {
  switch (id.slice(0, 3)) {
    case "gr_": return store.open({ kind: "grant", id });
    case "mt_": return store.open({ kind: "meeting", id });
    case "ag_": return store.open({ kind: "agent", id });
    case "bl_": return store.open({ kind: "building", id });
    case "kr_": return store.open({ kind: "goals", id });
    case "as_": return store.open({ kind: "assignment", id });
    case "se_": return store.open({ kind: "session", id });
    case "mf_": { window.open(mediaUrl(id), "_blank", "noopener"); return; }
    default: void openDocLink(id);
  }
}

const idClass = (id: string, named: boolean) => `doc-id${isGrantId(id) ? " grant-id" : ""}${named ? " named" : ""}`;

/** An id as a link, as `linkDocIds` produces it: opens in the panel, or in a new tab (its hash URL) so the current panel stays put. Media always opens its file in a new tab. */
const docIdAnchor = (id: string, newTab?: boolean) => {
  const label = idLabel(id);
  const out = newTab || !hasHash(id);
  return { className: idClass(id, !!label), title: idTitle(id, label), href: out ? urlOf(id) : id, target: out ? "_blank" : undefined, rel: out ? "noopener noreferrer" : undefined };
};

/** Plain text (no markdown) with linkable ids as links labelled by name; `newTab` keeps the current panel, e.g. a live meeting. */
export function DocText({ text, newTab }: { text: string; newTab?: boolean }) {
  const rev = useIdLabels(text);
  const parts = useMemo(() => docIdParts(text), [text, rev]);
  return (
    <>
      {parts.map((p, i) => typeof p === "string" ? p : (
        <a key={i} {...docIdAnchor(p.id, newTab)} onClick={newTab || !hasHash(p.id) ? undefined : (e) => { e.preventDefault(); openIdLink(p.id); }}>{idLabel(p.id) ?? p.id}</a>
      ))}
    </>
  );
}

/** One id as a link (panels that show a single id: a fork's assignment and session, a schedule's lane, an assignment card's fields). */
export function IdLink({ id }: { id: string }) {
  return <DocText text={id} />;
}

/** Wrap bare linkable ids in text nodes (outside links and code) in `<a href="dc_…">` (media: `<a href="/api/media/mf_…">`) so they open. */
function linkDocIds(root: Element) {
  const owner = root.ownerDocument;
  const texts: Text[] = [];
  const it = owner.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = it.nextNode(); n; n = it.nextNode()) {
    const v = n.nodeValue ?? "";
    if (!n.parentElement?.closest("a, code, pre") && v.includes("_")) texts.push(n as Text);
  }
  for (const t of texts) {
    const parts = docIdParts(t.nodeValue ?? "");
    if (parts.every((p) => typeof p === "string")) continue;
    t.replaceWith(...parts.map((p) => {
      if (typeof p === "string") return p;
      const a = owner.createElement("a");
      const label = idLabel(p.id);
      a.setAttribute("href", hasHash(p.id) ? p.id : mediaUrl(p.id));
      a.className = idClass(p.id, !!label);
      const title = idTitle(p.id, label);
      if (title) a.title = title;
      a.textContent = label ?? p.id;
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

/** `newTab`: id links open as their hash URL (`/#/doc/<id>`, `/#/grant/<id>`, …) in a new tab instead of replacing the current panel (used inside a live meeting). */
export function Markdown({ text, className, breaks = false, newTab = false }: { text: string; className?: string; breaks?: boolean; newTab?: boolean }) {
  const rev = useIdLabels(text);
  const html = useMemo(() => sanitize(markdownHtml(text, breaks)), [text, breaks, rev]);
  return (
    <div
      className={`md ${className ?? ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest("a");
        if (!a) return;
        const href = a.getAttribute("href") ?? "";
        if (/^(https?:|mailto:)/i.test(href) || href.startsWith(`${API_BASE}/api/media/`)) { a.target = "_blank"; a.rel = "noopener noreferrer"; return; }
        if (href.startsWith("#")) { e.preventDefault(); return; }
        const id = LINK_TARGET_RE.exec(href.split("/").pop() ?? "")?.[1];
        if (newTab && id) { a.href = urlOf(id); a.target = "_blank"; a.rel = "noopener noreferrer"; return; }
        e.preventDefault();
        if (id && !id.startsWith("dc_")) openIdLink(id);
        else void openDocLink(href);
      }}
    />
  );
}
