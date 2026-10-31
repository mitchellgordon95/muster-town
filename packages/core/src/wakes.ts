/**
 * Manager wakes on grant and key-result events (docs/wakes.md §4 step 3). A human's decision on a grant, or a human
 * writing, editing, marking or removing a key result of a building's goal, becomes one town-written report in that
 * building's in-tray (author "system", shown as Town); the runtime's `doc.created` branch then wakes (or feeds) the
 * manager's team-lead session, the same path as a resident's report. The manager acknowledges it with `review` approve.
 *
 * Events that already wake the manager with an assignment are left out: fund, counter and reject
 * (`Grants.decisionAssignment`) and `grant.checkpoint`. Each row carries the tag `wake:<rule>:<eventId>:<buildingId>`,
 * so delivering the same event twice writes nothing the second time.
 */
import type { Agent, Assignment, Doc, Event, Grant } from "@muster-town/schema";
import { createAssignment, createDoc, managerAgentOf, moveToFront } from "./domain.ts";
import { DIRECTED } from "./lanes.ts";
import { nowIso } from "./util.ts";
import type { World } from "./world.ts";
import { stamp } from "./time.ts";

const RULE = "manager-intray";

/** The tag that makes the row for `e` unique. */
export const wakeKey = (e: Event, buildingId: string) => `wake:${RULE}:${e.id}:${buildingId}`;

/** The in-tray row `e` calls for, written once; null when the event is not one (or it was already written). */
export function managerIntrayRow(world: World, e: Event): Doc | null {
  const row = describe(world, e);
  if (!row || !e.buildingId) return null;
  const building = world.buildings.get(e.buildingId);
  if (!building || building.kind === "town-hall" || !managerAgentOf(world, building)) return null;
  const key = wakeKey(e, building.id);
  if (world.docs.first("authorId = 'system' AND buildingId = ? AND tags LIKE ?", [building.id, `%"${key}"%`])) return null;
  return createDoc(world, {
    type: "report", state: "building", decision: "pending", buildingId: building.id, authorId: "system", authorKind: "user",
    tags: [RULE, key], title: row.title.slice(0, 200),
    body: [
      `Written by the town: ${row.what} (event ${e.id}, ${stamp(e.ts)}).`,
      `## Summary\n\n${row.summary}`,
      "Acknowledge it with `review` approve once you've taken it in; give any work it calls for with `assign`.",
    ].join("\n\n"),
  }, `Town wrote "${row.title.slice(0, 100)}" in ${building.name}'s in-tray`);
}

/** Title, one-line what and summary for a grant or key-result event a human caused; null for any other event. */
function describe(world: World, e: Event): { title: string; what: string; summary: string } | null {
  const p = e.payload as Record<string, unknown>;
  const human = humanName(world, e);
  if (!human) return null;
  if (e.type === "grant.funded" || e.type === "grant.closed") {
    const action = String(p.action ?? "");
    // fund has its own assignment (Grants.decisionAssignment); a manager closing its own grant is not a human event
    if (e.type === "grant.funded" && action !== "continue" && action !== "adjust") return null;
    const g = world.grants.get(String(p.grantId));
    if (!g) return null;
    const note = g.history.at(-1)?.note.trim();
    const verb = e.type === "grant.closed" ? (action === "cut" ? "cut" : `closed (${g.outcome ?? "closed"})`) : action === "adjust" ? "adjusted" : "continued";
    const tokens = e.type === "grant.funded" ? `: ${fmt(g.grantTokens ?? 0)} tokens` : "";
    return {
      title: `Grant ${g.id} ${verb}${tokens}`,
      what: `${human} ${verb} grant ${g.id} at its checkpoint`,
      summary: [`Grant ${g.id} "${g.objective}" ${verb} by ${human}${tokens}.`, grantLine(world, g), ...(note ? [`The note: ${note}`] : [])].join("\n\n"),
    };
  }
  if (e.type === "kr.created" || e.type === "kr.updated" || e.type === "kr.deleted") {
    const id = String(p.keyResultId);
    const kr = world.keyResults.get(id);
    const text = kr?.text ?? String(p.text ?? e.text);
    let verb: string, detail: string;
    if (e.type === "kr.created") { verb = "written"; detail = `How to check: ${kr?.howToCheck ?? p.howToCheck ?? ""}`; }
    else if (e.type === "kr.deleted") { verb = "removed"; detail = "It is no longer on the goal; work that named it keeps running until you reassign it."; }
    else if (p.edited !== true && p.objectiveId !== undefined && p.status === p.from) {
      const o = typeof p.objectiveId === "string" ? world.objectives.get(p.objectiveId) : undefined;
      verb = "moved"; detail = o ? `Now under objective ${o.id}: ${o.text}` : "Now under no objective (Unsorted).";
    }
    else if (p.edited !== true && typeof p.goalId === "string" && p.status === p.from) {
      // a goal-tree move (an accepted move proposal, a retired goal's key results): the status did not change
      const to = world.goals.get(p.goalId), from = typeof p.fromGoalId === "string" ? world.goals.get(p.fromGoalId) : undefined;
      verb = "moved"; detail = `Now under goal ${p.goalId}: ${to?.text ?? ""}${from ? `\nWas under goal ${from.id}: ${from.text}` : ""}\nStatus unchanged (${String(p.status)}).`;
    }
    else if (p.edited === true) { verb = "edited"; detail = `Was: ${String(p.fromText ?? "")}\nNow: ${text}\nHow to check: ${kr?.howToCheck ?? ""}`; }
    else { verb = `marked ${String(p.status)}`; detail = `Status ${String(p.from)} → ${String(p.status)}${kr?.statusNote ? `: ${kr.statusNote}` : ""}`; }
    return {
      title: `Key result ${id} ${verb} by ${human}`,
      what: `key result ${id} of the building goal was ${verb} by ${human}`,
      summary: `Key result ${id}: ${text}\n\n${detail}${p.grantId ? `\n\nGrant ${String(p.grantId)} works on it.` : ""}`,
    };
  }
  return null;
}

/** The human (an avatar or a user) behind the event, by name; null when an agent or the system acted. */
function humanName(world: World, e: Event): string | null {
  const p = e.payload as Record<string, unknown>;
  if (p.byKind === "user" && typeof p.by === "string") return world.nameOf(p.by);
  const a = e.agentId ? world.agents.get(e.agentId) : undefined;
  return a?.kind === "human" ? a.name : null;
}

const grantLine = (world: World, g: Grant) => {
  const krs = world.grantDesk.keyResultsOf(g.id);
  return `Status ${g.status}; ${fmt(world.grantDesk.view(g).spentTokens)} of ${fmt(g.grantTokens ?? 0)} tokens spent; key results ${krs.length ? krs.map((k) => `${k.id} [${k.status}] ${k.text}`).join("; ") : "(none)"}.`;
};

const fmt = (n: number) => n.toLocaleString("en-US");

/** Step 2: a relayed tell wakes only within this many hops of the human, and this long after the human acted. */
export const RELAY_MAX_HOPS = 3;
export const RELAY_MAX_AGE_MS = 24 * 3600_000;
const RELAY_PREFIX = "Message from ";

/** The line that makes the relay of `told` (an `agent.told` event) to `agentId` unique; it sits in the description. */
export const relayKey = (eventId: number | string, agentId: string) => `wake:relay:${eventId}:${agentId}`;

/**
 * Wakes step 2 (docs/wakes.md §4): a tell that traces to a human (`payload.origin`), sent to an idle resident, becomes a
 * pending directed "Message from <human> (via <sender>)" assignment with the text, or is merged into the one already
 * waiting for the same human and path. Inbox only (null) when it has no origin, is more than RELAY_MAX_HOPS relays or
 * 24 h from the human, the recipient is not an idle resident or has a work session running, or it was already relayed.
 * The scheduler's `canStart` stays the only gate on whether it runs.
 */
export function relayWake(world: World, from: Agent, told: Event): Assignment | null {
  const p = told.payload as { toId?: string; text?: string; origin?: Assignment["origin"] };
  const origin = p.origin;
  const to = p.toId ? world.agents.get(p.toId) : undefined;
  if (!origin || !to || to.kind !== "resident" || typeof p.text !== "string") return null;
  if (origin.hops > RELAY_MAX_HOPS || Date.now() - Date.parse(origin.at) > RELAY_MAX_AGE_MS) return null;
  if (to.status !== "idle" && to.status !== "out-of-budget") return null;
  if (world.sessions.count("agentId = ? AND status = 'running' AND purpose = 'work'", [to.id]) > 0) return null;
  const key = relayKey(told.id, to.id);
  if (world.assignments.first("agentId = ? AND description LIKE ?", [to.id, `%${key}%`])) return null;
  const human = world.nameOf(origin.userId);
  const tail = `\n\nReply to ${from.name} with \`tell\` (id ${from.id}) when it is done; it traces to ${human}.\n\n(${key})`;
  const pending = world.assignments.where("agentId = ? AND status = 'pending' AND title LIKE ?", [to.id, `${RELAY_PREFIX}%`])
    .find((a) => a.origin?.userId === origin.userId && a.origin.via === origin.via);
  if (pending) {
    const merged = world.assignments.upsert({ ...pending, description: `${pending.description}\n\nThen ${from.name} added:\n\n${p.text}${tail}`, updatedAt: nowIso() });
    return moveToFront(world, merged.id);
  }
  const first = p.text.split("\n")[0].trim();
  return createAssignment(world, {
    agentId: to.id, createdBy: { kind: "agent", id: from.id }, front: true, origin,
    laneOverride: { ...DIRECTED, sourceId: origin.via },
    title: `${RELAY_PREFIX}${human} (via ${from.name}): ${first.length > 80 ? first.slice(0, 79) + "…" : first}`,
    description: `${from.name} messaged you for ${human} (${origin.hops} hop${origin.hops === 1 ? "" : "s"} from them):\n\n${p.text}${tail}`,
  });
}

// ---- step 5: the leftover gaps (docs/wakes.md §4 step 5) ----

/** Whether the agent has a live work session: the runtime's view when it has one, else a running work Session row. */
export function isWorking(world: World, agentId: string): boolean {
  const viaHost = world.host.isWorking?.(agentId);
  return viaHost ?? world.sessions.count("agentId = ? AND status = 'running' AND purpose = 'work'", [agentId]) > 0;
}

/** Interrupt the agent's running session the way a human's message does: in-process if the runtime holds it, else queued for its desk. */
export function interruptNow(world: World, agentId: string, text: string, from: string): void {
  if (!world.host.interrupt?.(agentId, text, from, true)) world.ops.enqueueInterrupt(agentId, text, from, true);
}

/** Whether an item with `key` in its description was already written for the agent (a replay or double delivery). */
const already = (world: World, agentId: string, key: string) => !!world.assignments.first("agentId = ? AND description LIKE ?", [agentId, `%${key}%`]);

const firstLine = (s: string, n = 80) => { const f = s.trim().split("\n")[0].trim(); return f.length > n ? f.slice(0, n - 1) + "…" : f; };

export type StepFiveWake = { kind: "interrupt"; agentId: string } | { kind: "assignment"; agentId: string; assignment: Assignment } | null;

/** Rule `request-answer`: the line that makes the wake for `doc.updated` event `eventId` to `agentId` unique. */
export const requestAnswerKey = (eventId: number | string, agentId: string) => `wake:request-answer:${eventId}:${agentId}`;

/**
 * Rule `request-answer`: a human completed an agent's `request_human` (`requestAction` done, event `done`). A requester
 * with a running work session is interrupted with the answer; an idle (or out-of-budget) resident gets a pending
 * directed "Answer to your request <title>: <first line>" assignment at the front of its queue (sourceId = the
 * human-report). Anyone else (a visitor, a stopped agent) keeps the inbox line only. One per event and agent.
 */
export function requestAnswerWake(world: World, request: Doc, answer: Doc, done: Event): StepFiveWake {
  if (request.authorKind !== "agent") return null;
  const to = world.agents.get(request.authorId);
  if (!to || to.kind !== "resident") return null;
  const human = world.nameOf(answer.authorId);
  const key = requestAnswerKey(done.id, to.id);
  const text = `${human} answered your request "${request.title}" (${request.id}) in ${answer.id}:\n\n${answer.body.trim()}`;
  if (isWorking(world, to.id)) {
    if (world.interrupts.first("agentId = ? AND text LIKE ?", [to.id, `%${key}%`])) return null;
    interruptNow(world, to.id, `${text}\n\n(${key})`, human);
    return { kind: "interrupt", agentId: to.id };
  }
  if (to.status !== "idle" && to.status !== "out-of-budget") return null;
  if (already(world, to.id, key)) return null;
  const assignment = createAssignment(world, {
    agentId: to.id, createdBy: { kind: "user", id: answer.authorId }, front: true,
    origin: { userId: answer.authorId, via: answer.id, hops: 0, at: answer.createdAt },
    laneOverride: { ...DIRECTED, sourceId: answer.id },
    title: `Answer to your request ${firstLine(request.title, 60)}: ${firstLine(answer.body)}`,
    description: `${text}\n\nPick up the work that waited on it.\n\n(${key})`,
  });
  return { kind: "assignment", agentId: to.id, assignment };
}

/** Rule `decision`: the line that makes the wake for `meeting.decisions` event `eventId` to `agentId` unique. */
export const decisionKey = (eventId: number | string, agentId: string) => `wake:decision:${eventId}:${agentId}`;

/**
 * Rule `decision`: a meeting decision amended someone's *active* assignment (`supersedes`, same assignee; meetingDecide
 * rewrote it in place). A running session is interrupted with the decision text, like the redeploy notice; an idle
 * assignee whose active assignment has no session gets a pending assignment carrying the decision's lane fields.
 * New assignments from decisions are already pending (Q) and are left alone.
 */
export function decisionWakes(world: World, decided: Event): StepFiveWake[] {
  const p = decided.payload as { meetingId?: string; decisions?: Array<Record<string, unknown>> };
  const m = p.meetingId ? world.meetings.get(p.meetingId) : undefined;
  if (!m) return [];
  const out: StepFiveWake[] = [];
  for (const d of p.decisions ?? []) {
    if (d.supersedes === undefined || typeof d.assignmentId !== "string" || typeof d.assigneeId !== "string") continue;
    const a = world.assignments.get(d.assignmentId);
    if (!a || a.status !== "active" || a.agentId !== d.assigneeId) continue;
    const to = world.agents.get(a.agentId);
    if (!to || to.kind !== "resident") continue;
    const key = decisionKey(decided.id, to.id);
    const text = `Your current assignment "${a.title}" was amended in meeting "${m.title}" (${m.id}):\n\n${String(d.text)}`;
    if (isWorking(world, to.id)) {
      if (world.interrupts.first("agentId = ? AND text LIKE ?", [to.id, `%${key}%`])) continue;
      interruptNow(world, to.id, `${text}\n\n(${key})`, `Meeting "${m.title}"`);
      out.push({ kind: "interrupt", agentId: to.id });
      continue;
    }
    if (to.status !== "idle" && to.status !== "out-of-budget") continue;
    if (already(world, to.id, key)) continue;
    const assignment = createAssignment(world, {
      agentId: to.id, createdBy: { kind: "system", id: "system" }, front: true, fromMeetingId: m.id, origin: a.origin,
      // the decision's own lane fields when it names a lane, else the amended assignment's
      laneOverride: d.lane
        ? { lane: d.lane as Assignment["lane"], grantId: (d.grantId as string) ?? null, keyResultId: (d.keyResultId as string) ?? null, gap: (d.gap as string) ?? null, sourceId: (d.sourceId as string) ?? m.id }
        : { lane: a.lane, grantId: a.grantId, keyResultId: a.keyResultId, gap: a.gap, sourceId: a.sourceId },
      title: `Amended in meeting: ${firstLine(String(d.text), 100)}`,
      description: `${text}\n\nYour session for it is not running; this carries the amended work.\n\n(${key})`,
    });
    out.push({ kind: "assignment", agentId: to.id, assignment });
  }
  return out;
}

/** Rule `mention`: the line that makes the wake for `agent.mentioned` event `eventId` to `agentId` unique. */
export const mentionKey = (eventId: number | string, agentId: string) => `wake:mention:${eventId}:${agentId}`;
const MENTION_PREFIX = "Mentioned by ";

/**
 * Rule `mention`: the same shape as `relayWake` for an @mention that traces to a human (`payload.origin`, at most
 * RELAY_MAX_HOPS and 24 h from the human): an idle resident with no work session gets a pending directed
 * "Mentioned by <author> for <human>: …" assignment at the front (merged into a pending one for the same human and
 * path). Inbox only when there is no origin, it is past the caps, the target is busy or not a resident, or the mention
 * is in a live meeting the target attends (a meeting reply session, M, covers that).
 */
export function mentionWake(world: World, by: Agent, mentioned: Event, where: string): Assignment | null {
  const p = mentioned.payload as { toId?: string; meetingId?: string; docId?: string; origin?: Assignment["origin"] };
  const origin = p.origin;
  const to = p.toId ? world.agents.get(p.toId) : undefined;
  if (!origin || !to || to.kind !== "resident") return null;
  if (origin.hops > RELAY_MAX_HOPS || Date.now() - Date.parse(origin.at) > RELAY_MAX_AGE_MS) return null;
  if (p.meetingId) {
    const m = world.meetings.get(p.meetingId);
    if (m && m.attendeeIds.includes(to.id) && m.phase !== "done" && m.phase !== "cancelled") return null;
  }
  if (to.status !== "idle" && to.status !== "out-of-budget") return null;
  if (isWorking(world, to.id)) return null;
  const key = mentionKey(mentioned.id, to.id);
  if (already(world, to.id, key)) return null;
  const human = world.nameOf(origin.userId);
  const at = p.docId ? ` (${p.docId})` : p.meetingId ? ` (${p.meetingId})` : "";
  const tail = `\n\nIt traces to ${human}${origin.hops ? ` (${origin.hops} hop${origin.hops === 1 ? "" : "s"} from them)` : ""}. Act on it, then reply to ${by.name} with \`tell\` (id ${by.id}) if it asks for an answer.\n\n(${key})`;
  const pending = world.assignments.where("agentId = ? AND status = 'pending' AND title LIKE ?", [to.id, `${MENTION_PREFIX}%`])
    .find((a) => a.origin?.userId === origin.userId && a.origin.via === origin.via);
  if (pending) {
    const merged = world.assignments.upsert({ ...pending, description: `${pending.description}\n\nThen ${by.name} mentioned you again in ${where}${at}:\n\n${mentioned.text}${tail}`, updatedAt: nowIso() });
    return moveToFront(world, merged.id);
  }
  return createAssignment(world, {
    agentId: to.id, createdBy: by.kind === "human" && by.ownerUserId ? { kind: "user", id: by.ownerUserId } : { kind: "agent", id: by.id }, front: true, origin,
    laneOverride: { ...DIRECTED, sourceId: origin.via },
    title: `${MENTION_PREFIX}${by.name}${by.kind === "human" ? "" : ` for ${human}`}: ${firstLine(mentioned.text.replace(/^.*? mentioned you in /, ""))}`,
    description: `${by.name} mentioned you in ${where}${at}:\n\n${mentioned.text}${tail}`,
  });
}
