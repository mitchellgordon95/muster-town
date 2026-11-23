/**
 * The link sheet (grant gr_4csjpgh346 step 3, kr_sa1gn36ndz; Mitchell, 1:1 mt_0n8ttf1bur: "sidebars function as navigation or
 * detail views, central modals for content"): a doc (decks and pages too), a grant or an agent opened from a link anywhere
 * (a report's body, the library list, a meeting attachment, an in-tray sheet, a message) opens here, centred over the map and
 * over whatever side panel or sheet is open. Closing it (×, Esc, the backdrop) leaves that panel or sheet where it was.
 * The grant and agent panels draw their own frame as this Sheet through PanelShell's InSheet. An ask id (ak_) opens its card
 * here read-only, with what became of it when it is no longer open (gr_4upa0og9zc step 2): a human decides in the queue.
 */
import { useCallback, useEffect } from "react";
import { api, type AskView } from "../api";
import { store, useTown, type SheetRef } from "../state";
import { DocSheet } from "./DocView";
import { AgentPanel } from "./AgentPanel";
import { GrantPanel } from "./GrantPanel";
import { InSheet } from "./PanelShell";
import { Sheet } from "./Sheet";
import { AskCard } from "./AskCard";
import { Empty, ErrorLine, Loading, useLoad } from "./ui";

export function LinkSheet({ sheet }: { sheet: SheetRef }) {
  const close = useCallback(() => store.openSheet(null), []);
  const agentName = useTown((s) => (sheet.kind === "agent" ? s.agents[sheet.id]?.name : undefined));
  if (sheet.kind === "doc") return <DocLinkSheet id={sheet.id} onClose={close} />;
  if (sheet.kind === "ask") return <AskLinkSheet id={sheet.id} onClose={close} />;
  const label = sheet.kind === "grant" ? "Grant" : agentName ?? "Agent";
  return (
    <InSheet.Provider value={{ onClose: close, label }}>
      {sheet.kind === "grant" ? <GrantPanel id={sheet.id} /> : <AgentPanel id={sheet.id} tab={sheet.tab} />}
    </InSheet.Provider>
  );
}

/** A doc by id: the store's copy, else fetched; a loading or not-found line in the same sheet meanwhile. */
function DocLinkSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const cached = useTown((s) => s.docs[id]);
  const r = useLoad(() => api().doc(id), [id]);
  useEffect(() => { if (r.data) store.putDocs([r.data]); }, [r.data]);
  const doc = cached ?? r.data;
  if (doc) return <DocSheet doc={doc} onClose={onClose} />;
  return (
    <Sheet label="Document" title="Document" sub={id} onClose={onClose} escFirst maxWidth={980} className="doc-sheet">
      {r.loading ? <Loading /> : <><ErrorLine error={r.error} /><Empty>Document not found.</Empty></>}
    </Sheet>
  );
}

/** What became of an ask that is no longer open, in one line. */
export function askOutcome(a: AskView): string | null {
  const name = (id: string | null) => (id ? store.state.agents[id]?.name ?? store.names.get(id) ?? id : "someone");
  switch (a.status) {
    case "decided": return `Decided${a.decidedBy ? ` by ${name(a.decidedBy)}` : ""}${a.decision ? `: ${a.decision}` : "."}`;
    case "folded": return "Folded into another ask on the same thing.";
    case "retired": return `Closed${a.retiredBy ? `: ${a.retiredBy}` : "."}`;
    default: return null;
  }
}

/** An ask by id (ak_), its card read-only: the buttons stay in the decision queue. */
function AskLinkSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const r = useLoad(() => api().getAsk(id), [id]);
  const a = r.data;
  const outcome = a ? askOutcome(a) : null;
  return (
    <Sheet label="Ask" title={a?.title ?? "Ask"} sub={id} onClose={onClose} escFirst maxWidth={760} className="ask-sheet">
      {a ? (
        <>
          {outcome ? <p className="ask-outcome">{outcome}</p> : null}
          {a.status === "folded" && a.foldedInto ? <p><a className="doc-id" href={a.foldedInto} onClick={(e) => { e.preventDefault(); store.openSheet({ kind: "ask", id: a.foldedInto! }); }}>Open the ask it was folded into</a></p> : null}
          <AskCard ask={a} readOnly onDecided={() => undefined} />
          {a.status === "open" || a.status === "deferred" ? <p className="muted"><button className="link" onClick={() => { store.openSheet(null); store.open({ kind: "queue" }); }}>Decide it in the decision queue →</button></p> : null}
        </>
      ) : r.loading ? <Loading /> : <><ErrorLine error={r.error} /><Empty>Ask not found.</Empty></>}
    </Sheet>
  );
}
