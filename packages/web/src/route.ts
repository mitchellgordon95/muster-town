/**
 * Shareable URLs: `/#/doc/<id>` opens that doc in the library panel (`/#/doc/<id>/<n>`: a deck at slide n) and `/#/grant/<id>` opens that grant or
 * proposal; opening either puts its id in the address bar, so a link can be pasted into a report, chat or anywhere else.
 * `/#/connect` opens "Connect your agent" (the README's Bring your own agent section links it).
 * `/#/bank` opens the Bank page (tokens received, used and left, their sources, pools, spending and hosting in dollars; public).
 * `/#/finance`, the old Finance page's hash, opens the Bank too (1:1 mt_ew2d0mm7h9: one Bank page).
 * `/#/manual` opens the operating manual (the HUD's "?"), `/#/manual/<section>` at that section.
 */
import { store, type PanelRef } from "./state";

const DOC_HASH = /^#\/(doc|grant)\/([A-Za-z0-9_]+)(?:\/(\d+))?$|^#\/(connect|bank|finance)$|^#\/(manual)(?:\/([a-z0-9-]+))?$/;

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

/** The hash a panel is shared as: docs and grants have one, the rest none. */
const hashOf = (p: PanelRef | null): string => p?.kind === "library" && p.docId ? `#/doc/${p.docId}` : p?.kind === "grant" && p.id ? `#/grant/${p.id}` : p?.kind === "connect" || p?.kind === "bank" ? `#/${p.kind}`
  : p?.kind === "manual" ? `#/manual${p.id ? `/${p.id}` : ""}` : "";

function openFromHash() {
  const m = DOC_HASH.exec(location.hash);
  if (!m) return;
  const want: PanelRef = m[5] ? { kind: "manual", ...(m[6] ? { id: m[6] } : {}) } : m[4] ? { kind: m[4] === "connect" ? "connect" : "bank" } : m[1] === "grant" ? { kind: "grant", id: m[2] } : { kind: "library", docId: m[2] };
  if (m[4] === "finance") history.replaceState(null, "", "#/bank"); // the old Finance page's hash: its sections are on the Bank page now
  // a deck's slide hash (`/<n>`) is the deck viewer's to follow; it doesn't reopen the panel showing that deck
  if (m[1] === "doc" && m[2] === shownDeck) return;
  if (hashOf(store.state.panel) !== location.hash.replace(SLIDE_SUFFIX, "$1")) store.open(want);
}

/** Call once the town is loaded. Returns the cleanup. */
export function startDocRoutes(): () => void {
  openFromHash();
  window.addEventListener("hashchange", openFromHash);
  let last = store.state.panel;
  const unsubscribe = store.subscribe(() => {
    const p = store.state.panel;
    if (p === last) return;
    last = p;
    const want = hashOf(p);
    if (want ? location.hash.replace(SLIDE_SUFFIX, "$1") !== want : DOC_HASH.test(location.hash)) history.replaceState(null, "", want || location.pathname + location.search);
  });
  return () => { window.removeEventListener("hashchange", openFromHash); unsubscribe(); };
}
