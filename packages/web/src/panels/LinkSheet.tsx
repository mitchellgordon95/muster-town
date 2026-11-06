/**
 * The link sheet (grant gr_4csjpgh346 step 3, kr_sa1gn36ndz; Mitchell, 1:1 mt_0n8ttf1bur: "sidebars function as navigation or
 * detail views, central modals for content"): a doc (decks and pages too), a grant or an agent opened from a link anywhere
 * (a report's body, the library list, a meeting attachment, an in-tray sheet, a message) opens here, centred over the map and
 * over whatever side panel or sheet is open. Closing it (×, Esc, the backdrop) leaves that panel or sheet where it was.
 * The grant and agent panels draw their own frame as this Sheet through PanelShell's InSheet.
 */
import { useCallback, useEffect } from "react";
import { api } from "../api";
import { store, useTown, type SheetRef } from "../state";
import { DocSheet } from "./DocView";
import { AgentPanel } from "./AgentPanel";
import { GrantPanel } from "./GrantPanel";
import { InSheet } from "./PanelShell";
import { Sheet } from "./Sheet";
import { Empty, ErrorLine, Loading, useLoad } from "./ui";

export function LinkSheet({ sheet }: { sheet: SheetRef }) {
  const close = useCallback(() => store.openSheet(null), []);
  const agentName = useTown((s) => (sheet.kind === "agent" ? s.agents[sheet.id]?.name : undefined));
  if (sheet.kind === "doc") return <DocLinkSheet id={sheet.id} onClose={close} />;
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
