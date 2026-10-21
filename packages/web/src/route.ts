/**
 * Shareable doc URLs: `/#/doc/<id>` opens that doc in the library panel, and opening a doc there
 * puts its id in the address bar, so a link can be pasted into a report, chat or anywhere else.
 */
import { store } from "./state";

const DOC_HASH = /^#\/doc\/([A-Za-z0-9_]+)$/;

/** True when the page was opened on a shared doc link. */
export const isDocHash = () => DOC_HASH.test(location.hash);

export const docUrl = (id: string) => `${location.origin}${location.pathname}#/doc/${id}`;

function openFromHash() {
  const id = DOC_HASH.exec(location.hash)?.[1];
  const p = store.state.panel;
  if (id && !(p?.kind === "library" && p.docId === id)) store.open({ kind: "library", docId: id });
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
    const want = p?.kind === "library" && p.docId ? `#/doc/${p.docId}` : "";
    if (want ? location.hash !== want : DOC_HASH.test(location.hash)) history.replaceState(null, "", want || location.pathname + location.search);
  });
  return () => { window.removeEventListener("hashchange", openFromHash); unsubscribe(); };
}
