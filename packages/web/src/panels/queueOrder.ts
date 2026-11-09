/**
 * The decision queue's order (docs/legible-delegation.md §3; Mitchell's post docs/engineering-human-oversight.txt):
 * what the human pops off the front, one item at a time, at the Town Hall hydrant. Hook-free so the tests call it.
 *
 * The live asks come first, in the Secretary's order (sortAsks: rank, then oldest, deferred last). Then every waiting
 * item no ask is about (a goal proposal, a report, grant, retainer, captain or access row the server filed no ask for,
 * a building blocked with no key results), oldest first, so nothing waiting is lost. The items an ask is about are
 * its record, one click down from its card, not queue items of their own.
 */
import type { AccessRequestView, CaptainRequestView, Doc, GrantView, IntrayRoute, MeetingFocusKind, ScheduleView } from "@muster-town/schema";
import type { AskView, GoalProposalView, Intray } from "../api";
import { sortAsks } from "./asks";

export type Blocked = NonNullable<Intray["blocked"]>[number];

export type QueueItem =
  | { kind: "ask"; id: string; ask: AskView }
  | { kind: "report"; id: string; doc: Doc }
  | { kind: "grant"; id: string; grant: GrantView }
  | { kind: "retainer"; id: string; retainer: ScheduleView }
  | { kind: "captain"; id: string; req: CaptainRequestView }
  | { kind: "access"; id: string; req: AccessRequestView }
  | { kind: "goal"; id: string; proposal: GoalProposalView }
  | { kind: "blocked"; id: string; blocked: Blocked };

/** The waiting items of a Town Hall in-tray read, already filtered to the viewer's Mine / All / Funded view. */
interface QueueInput {
  asks: AskView[];
  reports: Doc[]; grants: GrantView[]; retainers: ScheduleView[]; captains: CaptainRequestView[];
  access: AccessRequestView[]; goalProposals: GoalProposalView[]; blocked: Blocked[];
}

/** Every id an ask is about or came from: an item with one of these ids is that ask's record, not a queue item. */
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

/** When an item started waiting (its line's "how long it has waited"). */
export function waitingSince(x: QueueItem): string | null {
  switch (x.kind) {
    case "ask": return x.ask.createdAt;
    case "report": return x.doc.createdAt;
    case "grant": return x.grant.updatedAt;
    case "retainer": return x.retainer.updatedAt;
    case "captain": case "access": return x.req.createdAt;
    case "goal": return x.proposal.createdAt;
    case "blocked": return x.blocked.since;
  }
}

/**
 * The queue, front first. `allAsks` is every ask the read carried (before the Mine filter), so an item whose ask is
 * only hidden by the view still counts as asked. Only a proposed or checkpoint grant waits on a human (a countered one
 * waits on the manager), and a retainer counts only
 * while it is asked: neither is in the queue.
 */
export function queueItems(t: QueueInput, allAsks: Pick<AskView, "targetId" | "sourceDocId" | "sources">[] = t.asks): QueueItem[] {
  const live = sortAsks(t.asks.filter((a) => a.status === "open" || a.status === "deferred"));
  const asked = askedIds(allAsks);
  const free = <T extends { id: string }>(xs: T[]) => xs.filter((x) => !asked.has(x.id));
  const rest: QueueItem[] = [
    ...free(t.reports).map((doc) => ({ kind: "report" as const, id: doc.id, doc })),
    ...free(t.grants).filter((g) => g.status === "proposed" || g.status === "checkpoint").map((grant) => ({ kind: "grant" as const, id: grant.id, grant })),
    ...free(t.retainers).filter((x) => x.retainer === "asked").map((retainer) => ({ kind: "retainer" as const, id: retainer.id, retainer })),
    ...free(t.captains).map((req) => ({ kind: "captain" as const, id: req.id, req })),
    ...free(t.access).map((req) => ({ kind: "access" as const, id: req.id, req })),
    ...free(t.goalProposals).map((proposal) => ({ kind: "goal" as const, id: proposal.id, proposal })),
    ...t.blocked.map((blocked) => ({ kind: "blocked" as const, id: `blocked:${blocked.buildingId}`, blocked })),
  ];
  rest.sort((a, b) => (waitingSince(a) ?? "9").localeCompare(waitingSince(b) ?? "9"));
  return [...live.map((ask) => ({ kind: "ask" as const, id: ask.id, ask })), ...rest];
}

/**
 * The item on screen: the one the human picked (from the list, or J / K) while it is still waiting, else the front.
 * Null when the queue is empty.
 */
export function currentItem(items: QueueItem[], picked: string | null): QueueItem | null {
  return (picked ? items.find((x) => x.id === picked) : undefined) ?? items[0] ?? null;
}

/** The id one step from `id` (J: +1, K: -1), clamped to the queue; peeking only, never deciding. */
export function stepFrom(items: QueueItem[], id: string | null, by: 1 | -1): string | null {
  if (!items.length) return null;
  const i = Math.max(0, items.findIndex((x) => x.id === id));
  return items[Math.min(items.length - 1, Math.max(0, i + by))]!.id;
}

/** A queue line's kind word: the ask's type, else what the item is. */
export function kindWord(x: QueueItem): string {
  switch (x.kind) {
    case "ask": return x.ask.type;
    case "report": return x.doc.type === "flag" ? "flag" : x.doc.tags.includes("rollup") ? "rollup" : "report";
    case "grant": return x.grant.status === "checkpoint" ? "checkpoint" : "proposal";
    case "retainer": return "retainer";
    case "captain": return "captain ask";
    case "access": return "join ask";
    case "goal": return "goal proposal";
    case "blocked": return "blocked";
  }
}

/** The building an item concerns, or null (the town). */
export function buildingOf(x: QueueItem): string | null {
  switch (x.kind) {
    case "ask": return x.ask.buildingId ?? null;
    case "report": return x.doc.buildingId ?? null;
    case "grant": return x.grant.buildingId;
    case "retainer": return x.retainer.buildingId;
    case "goal": return x.proposal.buildingId ?? null;
    case "blocked": return x.blocked.buildingId;
    default: return null;
  }
}

/** The item on screen as the Secretary's 1:1 hears it (PUT /api/meetings/:id/focus): the queue's kinds in the town's words. */
export function focusOf(x: QueueItem | null): { kind: MeetingFocusKind; id: string } | null {
  if (!x) return null;
  const kind: MeetingFocusKind = x.kind === "report" ? "doc" : x.kind === "goal" ? "goalProposal" : x.kind;
  return { kind, id: x.id };
}
