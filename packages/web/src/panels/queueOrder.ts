/**
 * The decision queue's order (docs/legible-delegation.md §3; Mitchell's post docs/engineering-human-oversight.txt):
 * what the human pops off the front, one item at a time, at the Town Hall hydrant. Hook-free so the tests call it.
 *
 * The live asks come first, in the Secretary's order (sortAsks: rank, then oldest, deferred last). Then every waiting
 * item no ask is about (a goal proposal, a report, a building blocked with no key results), oldest first, so nothing waiting is lost. The items an ask is about are
 * its record, one click down from its card, not queue items of their own.
 *
 * Only asks are decided (1:1 mt_t65exni4et decision 3): a grant proposal, a held grant, a retainer, a captain or an
 * access request is a need the town raised, and until its manager (or the Secretary) renders its ask it is not a queue
 * item. It shows as one plain line under the queue (cardsBeingWritten), with nothing to press.
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
export function askedIds(asks: Pick<AskView, "targetId" | "sourceDocId">[]): Set<string> {
  const ids = new Set<string>();
  for (const a of asks) {
    if (a.targetId) ids.add(a.targetId);
    if (a.sourceDocId) ids.add(a.sourceDocId);
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
 * only hidden by the view still counts as asked. Grants, retainers, captain and access requests enter only through
 * their ask (see cardsBeingWritten for the ones still waiting for it).
 */
export function queueItems(t: QueueInput, allAsks: Pick<AskView, "targetId" | "sourceDocId">[] = t.asks): QueueItem[] {
  const live = sortAsks(t.asks.filter((a) => a.status === "open" || a.status === "deferred"));
  const asked = askedIds(allAsks);
  const free = <T extends { id: string }>(xs: T[]) => xs.filter((x) => !asked.has(x.id));
  const rest: QueueItem[] = [
    ...free(t.reports).map((doc) => ({ kind: "report" as const, id: doc.id, doc })),
    ...free(t.goalProposals).map((proposal) => ({ kind: "goal" as const, id: proposal.id, proposal })),
    ...t.blocked.map((blocked) => ({ kind: "blocked" as const, id: `blocked:${blocked.buildingId}`, blocked })),
  ];
  rest.sort((a, b) => (waitingSince(a) ?? "9").localeCompare(waitingSince(b) ?? "9"));
  return [...live.map((ask) => ({ kind: "ask" as const, id: ask.id, ask })), ...rest];
}

/** A need the town raised with no ask yet: one plain line, nothing to decide on it. */
interface CardBeingWritten { id: string; buildingId: string | null; text: string; since: string | null }

/**
 * The needs waiting for their card, oldest first: a proposed or held grant, an asked retainer, a captain or an access
 * request no ask is about. `buildingName` turns a building id into its name ("Proposal from Prod: its card is being written.").
 */
export function cardsBeingWritten(t: Pick<QueueInput, "grants" | "retainers" | "captains" | "access">, allAsks: Pick<AskView, "targetId" | "sourceDocId" | "sources">[], buildingName: (id: string) => string | null = () => null): CardBeingWritten[] {
  const asked = askedIds(allAsks);
  const line = (what: string, b: string | null) => { const n = b ? buildingName(b) : null; return `${what}${n ? ` from ${n}` : ""}: its card is being written.`; };
  const out: CardBeingWritten[] = [
    ...t.grants.filter((g) => !asked.has(g.id) && (g.status === "proposed" || g.status === "checkpoint"))
      .map((g) => ({ id: g.id, buildingId: g.buildingId, since: g.updatedAt, text: line(g.status === "checkpoint" ? "Held grant" : "Proposal", g.buildingId) })),
    ...t.retainers.filter((x) => !asked.has(x.id) && x.retainer === "asked")
      .map((x) => ({ id: x.id, buildingId: x.buildingId, since: x.updatedAt, text: line("Retainer", x.buildingId) })),
    ...t.captains.filter((r) => !asked.has(r.id)).map((r) => ({ id: r.id, buildingId: null, since: r.createdAt, text: line("Captain request", null) })),
    ...t.access.filter((r) => !asked.has(r.id)).map((r) => ({ id: r.id, buildingId: null, since: r.createdAt, text: line("Join request", null) })),
  ];
  return out.sort((a, b) => (a.since ?? "9").localeCompare(b.since ?? "9"));
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
    case "ask": return x.ask.type === "money" ? "tokens" : x.ask.type; // the card's header word: "is asking for tokens"
    case "report": return x.doc.type === "flag" ? "flag" : "report";
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
