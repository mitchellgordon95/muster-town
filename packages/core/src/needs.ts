/**
 * Needs (Mitchell, 1:1 mt_t65exni4et 2026-11-15 decision 2): a need is an entry on a job's thread at level human that
 * says a human must decide something: "Grant gr_x wants funding", "Grant gr_x reached its gate", "Request dc_x asks a
 * human". It is a fact and follows no presentation rule. An ask is the card a manager (or, as a backstop, the Secretary)
 * renders from it for the decision queue: `asks.sourceEntryId` names the need. The town writes needs and never cards.
 *
 * - Written by code where the fact appears: a grant proposed (`grant.proposed`), a grant held at its ceiling or forecast
 *   past it (grants.ts, grant-forecast.ts), an outbox request (`request_human`).
 * - Open until answered: the event that decides its target answers it (asks.ts `retireAsks` calls `settleNeeds`), and a
 *   newer need on the same target supersedes it.
 * - Unrendered while no live ask is on its target: it sits in the manager's in-tray (`managerQueue`), which wakes the
 *   manager; past `NEED_BACKSTOP_MS` the Secretary renders it and the manager is told (secretary.ts).
 */
import type { Ask, AskBranch, AskTargetKind, AskType } from "@muster-town/schema";
import { answerEntry, appendEntry, entryOf, type Entry } from "./jobs.ts";
import { TOWN_HALL_ID } from "./world/layout.ts";
import type { World } from "./world.ts";

export type NeedKind = "proposal" | "gate" | "request" | "retainer" | "captain" | "access" | "rule";

/** An open need, read back from its entry. */
export interface Need {
  entry: Entry;
  need: NeedKind;
  targetKind: AskTargetKind;
  targetId: string;
  /** the ask type its card must have, and its buttons: they map onto the target's own verbs, so the renderer can't change them */
  type: AskType;
  branches: AskBranch[];
  /** the building whose thread holds it: its manager renders it */
  buildingId: string;
}

/** A need left unrendered this long is rendered by the Secretary, and its manager is told (decision 2 point 3). */
export const NEED_BACKSTOP_MS = 60 * 60_000;

export const PROPOSAL_BRANCHES: AskBranch[] = [{ label: "Fund", action: "fund" }, { label: "Counter", action: "counter" }, { label: "Reject", action: "reject" }];
export const GATE_BRANCHES: AskBranch[] = [{ label: "Adjust", action: "adjust" }, { label: "Cut", action: "cut" }];
/** A request's two branches (1:1 mt_msnjkpgwdb decision 17: no Claim): Done with the report back, Decline with a note. */
export const DO_BRANCHES: AskBranch[] = [{ label: "Done", action: "done" }, { label: "Decline", action: "decline" }];

/** A request for a token, key or credential (the click it asks for is issuing one). */
const CREDENTIAL = /\b(token|tokens|credential|credentials|api[- ]?key|keys?|PAT|password|secret|ssh|oauth|scope)\b/i;
/** A request's ask type: a credential ask when it asks for a token or key, else a do. */
export const requestType = (d: { title: string; body: string }): AskType => (CREDENTIAL.test(`${d.title}\n${d.body}`) ? "credential" : "do");

export interface NewNeed {
  need: NeedKind; targetKind: AskTargetKind; targetId: string; type: AskType; branches: AskBranch[];
  jobId: string; note: string; body: string;
  id?: string; authorKind?: Entry["authorKind"]; authorId?: string; docId?: string | null; assignmentId?: string | null; createdAt?: string;
}

/**
 * Write a need on a job's thread (level human), superseding an open need of the same kind on the same target (a new gate
 * replaces the old gate; it is answered with a pointer to the new one). A need of another kind on that target stays
 * open: one need, one ask (1:1 mt_dwsxo7oms8 decision 3). Null when the thread does not exist or the id was already written.
 */
export function fileNeed(world: World, n: NewNeed): Entry | null {
  const older = openNeedsOn(world, n.targetKind, n.targetId).filter((o) => o.need === n.need);
  const e = appendEntry(world, {
    id: n.id, jobId: n.jobId, authorKind: n.authorKind ?? "code", authorId: n.authorId ?? "system", level: "human",
    note: n.note, body: n.body, docId: n.docId ?? null, assignmentId: n.assignmentId ?? null, createdAt: n.createdAt,
    moved: { kind: "need", need: n.need, targetKind: n.targetKind, targetId: n.targetId, type: n.type, branches: n.branches },
  });
  if (e) for (const o of older) answerEntry(world, o.entry.id, { kind: "system", id: "system" }, "superseded", `Superseded by ${e.id}: ${e.note}`.slice(0, 500));
  return e;
}

/** An entry as a need, when it is one: a `need` entry, or an outbox request's entry written before needs (`kind: do`). */
function needOf(world: World, e: Entry, buildingId: string): Need | null {
  const m = e.moved;
  if (m.kind === "need" && typeof m.targetId === "string") {
    return { entry: e, need: m.need as NeedKind, targetKind: m.targetKind as AskTargetKind, targetId: m.targetId, type: m.type as AskType, branches: (m.branches as AskBranch[]) ?? [], buildingId };
  }
  if (m.kind === "do" && typeof m.requestId === "string") {
    const d = world.docs.get(m.requestId);
    return { entry: e, need: "request", targetKind: "request", targetId: m.requestId, type: d ? requestType(d) : "do", branches: DO_BRANCHES, buildingId };
  }
  return null;
}

const OPEN_NEEDS = `SELECT e.*, j.buildingId AS needBuilding FROM entries e JOIN jobs j ON j.id = e.jobId
  WHERE e.level = 'human' AND json_extract(e.moved, '$.kind') IN ('need', 'do') AND NOT EXISTS (SELECT 1 FROM entries x WHERE x.answers = e.id)`;

function readNeeds(world: World, where: string, args: unknown[]): Need[] {
  const rows = world.db.prepare(`${OPEN_NEEDS} ${where} ORDER BY e.createdAt, e.rowid`).all(...args) as (Record<string, unknown> & { needBuilding: string })[];
  return rows.flatMap((r) => {
    const e = entryOf(world, String(r.id));
    const n = e ? needOf(world, e, r.needBuilding) : null;
    // a request's legacy entry stays open only while the request does (its answers were never written on the thread)
    if (n && n.targetKind === "request" && world.docs.get(n.targetId)?.requestStatus !== "open") return [];
    return n ? [n] : [];
  });
}

/** Every open need (of one building, when given), oldest first. */
function openNeeds(world: World, buildingId?: string): Need[] {
  return buildingId ? readNeeds(world, "AND j.buildingId = ?", [buildingId]) : readNeeds(world, "", []);
}

/** The open needs on one target (normally one). */
export function openNeedsOn(world: World, kind: AskTargetKind, id: string): Need[] {
  return readNeeds(world, "AND (json_extract(e.moved, '$.targetId') = ? OR json_extract(e.moved, '$.requestId') = ?)", [id, id]).filter((n) => n.targetKind === kind);
}

/** The need kind an entry raised, when it is a need: a `need` entry's own, or "request" for an outbox request's legacy entry. */
function needKindOf(world: World, entryId: string | null): NeedKind | null {
  const m = entryId ? entryOf(world, entryId)?.moved : undefined;
  return m?.kind === "need" ? (m.need as NeedKind) : m?.kind === "do" ? "request" : null;
}

/**
 * The live ask that renders a need (1:1 mt_dwsxo7oms8 decisions 2-3: one need, one ask): the ask filed on its entry, else
 * a card of the same type on its target that views no need of another kind and is no manager's own `ask` entry: the old
 * need's card under a newer need of the same kind (a new gate), or a card filed before needs. A manager's ask on the same
 * target (a credential beside a proposal, a policy on the grant) is a need of its own and never renders this one.
 */
export function liveAskForNeed(world: World, n: Pick<Need, "entry" | "need" | "type" | "targetKind" | "targetId">): Ask | undefined {
  const live = "status IN ('open', 'deferred')";
  return world.asks.first(`sourceEntryId = ? AND ${live}`, [n.entry.id], "ORDER BY createdAt, rowid")
    ?? world.asks.where(`targetKind = ? AND targetId = ? AND type = ? AND ${live}`, [n.targetKind, n.targetId, n.type], "ORDER BY createdAt, rowid").find((a) => {
      const raised = a.sourceEntryId ? entryOf(world, a.sourceEntryId) : null;
      if (raised?.moved.kind === "ask") return false;
      const kind = needKindOf(world, a.sourceEntryId);
      return kind === null || kind === n.need;
    });
}

const hasLiveAsk = (world: World, n: Need) => !!liveAskForNeed(world, n);

/** The open needs no card renders yet (of one building, when given), oldest first: the manager's to render. */
export function unrenderedNeeds(world: World, buildingId?: string): Need[] {
  return openNeeds(world, buildingId).filter((n) => !hasLiveAsk(world, n));
}

/** Unrendered needs older than the backstop, and every unrendered need of the Town Hall: the Secretary's to render (`now` in ms). */
export function overdueNeeds(world: World, now: number): Need[] {
  // the Town Hall's own needs (a captain or access request) have no other manager: the Secretary renders them at once
  return unrenderedNeeds(world).filter((n) => n.buildingId === TOWN_HALL_ID || now - Date.parse(n.entry.createdAt) >= NEED_BACKSTOP_MS);
}

/** An open need by its entry id; null when it is not an open need. */
export function openNeed(world: World, entryId: string): Need | null {
  return readNeeds(world, "AND e.id = ?", [entryId])[0] ?? null;
}

/**
 * The event that decides a target fired (asks.ts `retireAsks`): every open need on it is answered with that event's
 * text. `card`: the ask a human saw when they decided it, kept on the answer entry beside their words (decision 2 point 5).
 */
export function settleNeeds(world: World, kind: AskTargetKind, id: string, reason: string, by: string | false, card: CardShown | null): Entry[] {
  return openNeedsOn(world, kind, id).flatMap((n) => {
    const e = answerEntry(world, n.entry.id, by ? { kind: "user", id: by } : { kind: "system", id: "system" }, by ? "decided" : "settled", reason.slice(0, 1500), card ? { moved: { card }, body: cardText(card) } : {});
    return e ? [e] : [];
  });
}

/** The card a human saw when they decided (decision 2 point 5): stored on the decision's entry. */
interface CardShown { askId: string; title: string; body: string; branches: string[]; recommendation: string }

export const cardShown = (a: { id: string; title: string; body: string; branches: AskBranch[]; recommendation: string }): CardShown =>
  ({ askId: a.id, title: a.title, body: a.body, branches: a.branches.map((b) => b.label), recommendation: a.recommendation });

/** The card as plain text for the entry's body. */
export const cardText = (c: CardShown): string =>
  [`The card the human saw (${c.askId}):`, `# ${c.title}`, c.body.trim(), `Branches: ${c.branches.join(" / ")}`, c.recommendation.trim() ? `Recommendation: ${c.recommendation.trim()}` : ""].filter(Boolean).join("\n\n");
