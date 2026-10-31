/**
 * The Queue tab (docs/goals.md "Kanban: the queue as a board", build step 6): a building's assignments as four columns,
 * Queued / Held / Running / Done, on the building panel (GET /api/buildings/:id/queue) and on a goal node, where every
 * building attached in the subtree gets a swimlane (GET /api/goals/:id/queue). Read-only: the queue order is the
 * manager's, and the Running header's desks are the WIP limit the scheduler already keeps.
 */
import { useState } from "react";
import type { QueueBoard, QueueCard, QueueLane } from "@muster-town/schema";
import { api } from "../api";
import { store, useTown } from "../state";
import { openDocLink } from "./Markdown";
import { ADJ, Empty, ErrorLine, Loading, Pill, fmtTokens, timeAgo, useLoad } from "./ui";

const COLUMNS: { id: "queued" | "held" | "running" | "done"; label: string }[] = [
  { id: "queued", label: "Queued" }, { id: "held", label: "Held" }, { id: "running", label: "Running" }, { id: "done", label: "Done (24 h)" },
];

/** Done (24 h) shows its latest cards only (the API sends them newest first); a busy building has dozens a day. */
export const DONE_SHOWN = 10;

/** "Running 3 / 6 desks": the column header, with the WIP limit on Running. */
export function columnHeader(lane: QueueLane, col: (typeof COLUMNS)[number]["id"]): string {
  const label = COLUMNS.find((c) => c.id === col)!.label;
  return col === "running" ? `${label} ${lane.running.length} / ${lane.desks} desk${lane.desks === 1 ? "" : "s"}` : `${label} ${lane[col].length}`;
}

export function QueueTab({ goalId, buildingId }: { goalId?: string; buildingId?: string }) {
  const rev = useTown((s) => s.rev);
  const r = useLoad<QueueBoard>(() => goalId ? api().goalQueue(goalId) : api().buildingQueue(buildingId!), [goalId, buildingId, rev]);
  const d = r.data;
  return (
    <div className="queue-board">
      <div className="muted">The queue as a board, read-only: the manager orders it; the desks are the limit on Running.</div>
      <ErrorLine error={r.error} />
      {!d ? (r.loading ? <Loading /> : null) : !d.lanes.length ? <Empty>No building is attached under this goal.</Empty>
        : d.lanes.map((lane) => <Lane key={lane.buildingId} lane={lane} title={!!goalId} />)}
    </div>
  );
}

export function Lane({ lane, title }: { lane: QueueLane; title: boolean }) {
  return (
    <div className="queue-lane">
      {title ? <button className="link queue-lane-name" onClick={() => store.open({ kind: "building", id: lane.buildingId })}>{lane.buildingName}</button> : null}
      <div className="queue-cols">
        {COLUMNS.map((c) => (
          <div key={c.id} className={`queue-col ${c.id === "running" && lane.running.length >= lane.desks ? "full" : ""}`}>
            <div className="queue-col-head">{columnHeader(lane, c.id)}</div>
            {c.id === "done" ? <DoneCards cards={lane.done} /> : lane[c.id].map((x) => <Card key={x.id} c={x} />)}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The latest DONE_SHOWN done cards, then "Show all (N)" / "Show latest 10"; Queued, Held and Running stay whole. */
function DoneCards({ cards }: { cards: QueueCard[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? cards : cards.slice(0, DONE_SHOWN);
  return (
    <>
      {shown.map((x) => <Card key={x.id} c={x} />)}
      {cards.length > DONE_SHOWN ? <button className="link queue-col-more" onClick={() => setAll(!all)}>{all ? `Show latest ${DONE_SHOWN}` : `Show all (${cards.length})`}</button> : null}
    </>
  );
}

function Card({ c }: { c: QueueCard }) {
  return (
    <div className={`queue-card ${c.status === "cancelled" ? "cancelled" : ""}`} title={c.title}>
      <div className="queue-card-title">{c.reportId ? <button className="link" onClick={() => void openDocLink(c.reportId!)}>{c.title}</button> : c.title}</div>
      <div className="queue-card-meta">
        <Pill>{c.lane}</Pill>
        {c.grantId ? <button className="link" onClick={() => store.open({ kind: "grant", id: c.grantId! })}>grant</button> : c.keyResultId ? <span className="muted" title={c.keyResultId}>KR</span> : null}
        <span className="muted">{c.agentName}</span>
        <span className="muted">{timeAgo(c.status === "pending" ? c.createdAt : c.updatedAt)}</span>
        {c.status === "cancelled" ? <Pill tone="bad">cancelled</Pill> : null}
        {c.tokens !== null ? <span className="muted" title={ADJ}>{fmtTokens(c.tokens)}</span> : null}
      </div>
      {c.heldReason ? <div className="queue-card-held muted">{c.heldReason}</div> : null}
    </div>
  );
}
