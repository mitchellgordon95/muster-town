/**
 * The Town Hall in-tray as asks (docs/legible-delegation.md §3, UI / UX B and D): the ask cards first, in the
 * Secretary's rank then oldest (deferred ones last, stamped), the closed loops beside them, and the records (rollups,
 * and the grant, retainer, captain and access rows that already have an ask) collapsed under one "Records" disclosure,
 * so nothing disappears. "Funding" opens the slate (FundingView), "Feed" the notices.
 */
import { useState, type ReactNode } from "react";
import type { GrantView, IntrayRoute, Notice } from "@muster-town/schema";
import type { AskView } from "../api";
import { AskCard } from "./AskCard";
import { sortAsks, slateAsks } from "./asks";
import { FundingView } from "./FundingView";
import { ClosedLoops, NoticesFeed } from "./NoticesPanel";
import { Sheet } from "./Sheet";
import { Empty, Pill } from "./ui";

/** Every id an ask is about or came from: the in-tray items with one of these ids are records under the disclosure. */
export function askedIds(asks: Pick<AskView, "targetId" | "sourceDocId" | "sources">[]): Set<string> {
  const ids = new Set<string>();
  for (const a of asks) {
    if (a.targetId) ids.add(a.targetId);
    if (a.sourceDocId) ids.add(a.sourceDocId);
    for (const s of a.sources) ids.add(s.docId);
  }
  return ids;
}

/** Under "Mine", the asks whose item is routed to the viewer, and every ask with no route (a policy, a meeting). */
export function mineAsks(asks: AskView[], routes: Record<string, IntrayRoute>, mine: boolean): AskView[] {
  if (!mine) return asks;
  return asks.filter((a) => { const r = routes[a.targetId ?? ""] ?? routes[a.sourceDocId ?? ""]; return !r || r.mine; });
}

export function AsksIntray({ asks, grants, notices = [], routes = {}, records, recordCount, rest, onDecided, onOpenRecord }: {
  asks: AskView[]; grants: GrantView[]; notices?: Notice[]; routes?: Record<string, IntrayRoute>;
  /** the in-tray items that have an ask (the old rows), shown under Records */
  records: ReactNode; recordCount: number;
  /** the in-tray items with no ask yet (the old rows, shown under the cards) */
  rest?: ReactNode;
  onDecided: () => void; onOpenRecord: (id: string) => void;
}) {
  const [sheet, setSheet] = useState<"funding" | "feed" | null>(null);
  const byId = new Map(grants.map((g) => [g.id, g]));
  const sorted = sortAsks(asks);
  const slate = slateAsks(asks, grants).length;
  return (
    <>
      <div className="intray-asks-head actions">
        <button className="btn sm" onClick={() => setSheet("funding")} title="The money asks on proposals as a slate: toggle fund or hold and watch the Bank">Funding{slate ? <> <Pill tone="warn">{slate}</Pill></> : null}</button>
        <button className="btn sm" onClick={() => setSheet("feed")} title="What shipped, closed or was verified: nothing to decide">Feed</button>
      </div>
      <div className="intray-asks">
        <div className="intray-asks-main">
          {sorted.length ? sorted.map((a) => (
            <AskCard key={a.id} ask={a} grant={a.targetKind === "grant" ? byId.get(a.targetId ?? "") : undefined} canDecide={routes[a.targetId ?? ""]?.canDecide} onDecided={onDecided} onOpenRecord={onOpenRecord} />
          )) : <Empty>No ask waits for you. Records and the feed stay one click away.</Empty>}
        </div>
        <ClosedLoops notices={notices} />
      </div>
      {rest}
      {recordCount ? (
        <details className="intray-records">
          <summary>Records <Pill>{recordCount}</Pill> <span className="muted">the rollups, grants and requests behind these asks</span></summary>
          {records}
        </details>
      ) : null}
      {sheet === "funding" ? (
        <Sheet label="Funding" title="Funding" sub="The slate: toggle, then decide each card" onClose={() => setSheet(null)} escFirst maxWidth={860}>
          <FundingView asks={asks} grants={grants} notices={notices} onDecided={onDecided} onOpenRecord={(id) => { setSheet(null); onOpenRecord(id); }} />
        </Sheet>
      ) : sheet === "feed" ? (
        <Sheet label="Feed" title="Feed" sub="What shipped, closed and was verified" onClose={() => setSheet(null)} escFirst maxWidth={760}>
          <NoticesFeed />
        </Sheet>
      ) : null}
    </>
  );
}
