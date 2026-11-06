/**
 * Shareable URLs: `/#/doc/<id>` opens that doc in the link sheet (`/#/doc/<id>/<n>`: a deck at slide n), `/#/grant/<id>` that grant or
 * proposal and `/#/agent/<id>` that agent (gr_4csjpgh346 step 3: content opens centred, over whatever side panel is open); opening one
 * puts its hash in the address bar, so a link can be pasted into a report, chat or anywhere else, and closing it puts back the panel's.
 * `/#/connect` opens "Connect your agent" (the README's Bring your own agent section links it).
 * `/#/bank` opens the Bank page (tokens received, used and left, their sources, free tokens, spending and hosting in dollars; public).
 * `/#/finance`, the old Finance page's hash, opens the Bank too (1:1 mt_ew2d0mm7h9: one Bank page).
 * `/#/meeting/<id>`, `/#/building/<id>` (a bl_ id, or `workshop` / `town-hall`: the two buildings without a prefixed id), `/#/assignment/<id>`, `/#/session/<id>` open that panel and `/#/kr/<id>` the goal tree at that key result: an id link
 * in a live meeting opens one in a new tab (Markdown `newTab`). They are read on load and on a hash change; the address bar doesn't follow those panels.
 * `/#/manual` opens the operating manual (the HUD's "?"), `/#/manual/<section>` at that section.
 */
import { store, type PanelRef, type SheetRef } from "./state";

const DOC_HASH = /^#\/(doc|grant)\/([A-Za-z0-9_]+)(?:\/(\d+))?$|^#\/(connect|bank|finance)$|^#\/(manual)(?:\/([a-z0-9-]+))?$|^#\/(meeting|agent|building|kr|assignment|session)\/([a-z]{2}_[a-z0-9]{10})$|^#\/(building)\/(workshop|town-hall)$/;

/** True when the page was opened on a shared doc or grant link. */
export const isDocHash = () => DOC_HASH.test(location.hash);

export const docUrl = (id: string) => `${location.origin}${location.pathname}#/doc/${id}`;
export const grantUrl = (id: string) => `${location.origin}${location.pathname}#/grant/${id}`;

const SLIDE_SUFFIX = /(^#\/doc\/[A-Za-z0-9_]+)\/\d+$/;

/** `#/doc/<id>/<n>` (n from 1; slide 1 is the bare `#/doc/<id>`). */
export const slideHash = (id: string, n: number) => n > 1 ? `#/doc/${id}/${n}` : `#/doc/${id}`;
/** The slide a hash names for this deck (1 for the bare doc hash), or null when it names something else. */
export function slideOfHash(hash: string, id: string): number | null {
  const m = /^#\/doc\/([A-Za-z0-9_]+)(?:\/(\d+))?$/.exec(hash);
  return m && m[1] === id ? Math.max(1, Number(m[2] ?? 1)) : null;
}

/** The deck the viewer is showing (wherever it is open: library, cabinet, in-tray), so its slide hashes don't reopen panels. */
let shownDeck: string | null = null;
export function setShownDeck(id: string | null) { shownDeck = id; }

/** The hash a panel is shared as: the Bank, Connect and the manual have one, the rest none (docs and grants open as sheets). */
const hashOf = (p: PanelRef | null): string => p?.kind === "connect" || p?.kind === "bank" ? `#/${p.kind}`
  : p?.kind === "manual" ? `#/manual${p.id ? `/${p.id}` : ""}` : "";
/** The hash a link sheet is shared as. */
const sheetHash = (s: SheetRef): string => `#/${s.kind}/${s.id}`;
/** What the address bar should say: the open sheet's hash, else the panel's ("" for none). */
export const shownHash = (sheet: SheetRef | null, panel: PanelRef | null): string => sheet ? sheetHash(sheet) : hashOf(panel);

/** What a hash opens: a link sheet (doc, grant, agent) or a panel; null when it names nothing. Exported for the tests. */
export function routeOf(hash: string): { sheet: SheetRef } | { panel: PanelRef } | null {
  const m = DOC_HASH.exec(hash);
  if (!m) return null;
  if (m[1]) return { sheet: { kind: m[1] as "doc" | "grant", id: m[2] } };
  if (m[7] === "agent") return { sheet: { kind: "agent", id: m[8] } };
  if (m[7]) return { panel: { kind: m[7] === "kr" ? "goals" : m[7] as "meeting" | "building" | "assignment" | "session", id: m[8] } };
  if (m[9]) return { panel: { kind: "building", id: m[10] } }; // the two buildings whose ids have no xx_ prefix
  if (m[5]) return { panel: { kind: "manual", ...(m[6] ? { id: m[6] } : {}) } };
  return { panel: { kind: m[4] === "connect" ? "connect" : "bank" } };
}

function openFromHash() {
  const m = DOC_HASH.exec(location.hash);
  const r = routeOf(location.hash);
  if (!m || !r) return;
  if (m[4] === "finance") history.replaceState(null, "", "#/bank"); // the old Finance page's hash: its sections are on the Bank page now
  // a deck's slide hash (`/<n>`) is the deck viewer's to follow; it doesn't reopen the sheet showing that deck
  if (m[1] === "doc" && m[2] === shownDeck) return;
  if (shownHash(store.state.sheet, store.state.panel) === location.hash.replace(SLIDE_SUFFIX, "$1")) return;
  if ("sheet" in r) store.openSheet(r.sheet);
  else store.open(r.panel);
}

/** Call once the town is loaded. Returns the cleanup. */
export function startDocRoutes(): () => void {
  openFromHash();
  window.addEventListener("hashchange", openFromHash);
  let last = store.state.panel;
  let lastSheet = store.state.sheet;
  const unsubscribe = store.subscribe(() => {
    const { panel: p, sheet } = store.state;
    if (p === last && sheet === lastSheet) return;
    last = p;
    lastSheet = sheet;
    const want = shownHash(sheet, p);
    if (want ? location.hash.replace(SLIDE_SUFFIX, "$1") !== want : DOC_HASH.test(location.hash)) history.replaceState(null, "", want || location.pathname + location.search);
  });
  return () => { window.removeEventListener("hashchange", openFromHash); unsubscribe(); };
}
