/**
 * Shareable URLs: `/#/doc/<id>` opens that doc in the library panel and `/#/grant/<id>` opens that grant or
 * proposal; opening either puts its id in the address bar, so a link can be pasted into a report, chat or anywhere else.
 * `/#/connect` opens "Connect your agent" (the README's Bring your own agent section links it).
 */
import { store, type PanelRef } from "./state";

const DOC_HASH = /^#\/(doc|grant)\/([A-Za-z0-9_]+)$|^#\/(connect)$/;

/** True when the page was opened on a shared doc or grant link. */
export const isDocHash = () => DOC_HASH.test(location.hash);

export const docUrl = (id: string) => `${location.origin}${location.pathname}#/doc/${id}`;
export const grantUrl = (id: string) => `${location.origin}${location.pathname}#/grant/${id}`;

/** The hash a panel is shared as: docs and grants have one, the rest none. */
const hashOf = (p: PanelRef | null): string => p?.kind === "library" && p.docId ? `#/doc/${p.docId}` : p?.kind === "grant" && p.id ? `#/grant/${p.id}` : p?.kind === "connect" ? "#/connect" : "";

function openFromHash() {
  const m = DOC_HASH.exec(location.hash);
  if (!m) return;
  const want: PanelRef = m[3] ? { kind: "connect" } : m[1] === "grant" ? { kind: "grant", id: m[2] } : { kind: "library", docId: m[2] };
  if (hashOf(store.state.panel) !== location.hash) store.open(want);
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
    if (want ? location.hash !== want : DOC_HASH.test(location.hash)) history.replaceState(null, "", want || location.pathname + location.search);
  });
  return () => { window.removeEventListener("hashchange", openFromHash); unsubscribe(); };
}
