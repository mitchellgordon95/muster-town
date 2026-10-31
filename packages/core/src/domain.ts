import { Doc, QUEUE_ORDER, type Agent, type Assignment, type AssignmentQueue, type Building, type AccessRequestView, type GrantView, type LaneFields, type Message, type Origin, type ReviewDecision, type WaitFor } from "@muster-town/schema";
import { AppError } from "./errors.ts";
import { DIRECTED, meetingHadHuman, resolveLane, type Lane } from "./lanes.ts";
import type { Holder } from "./permissions.ts";
import { humanOrigin, meetingOrigin } from "./origin.ts";
import { describeWait } from "./waits.ts";
import { extractSection, firstLine, newId, nowIso, truncate } from "./util.ts";
import type { World } from "./world.ts";
import type { BlockedBuilding } from "./grants.ts";
import type { GoalProposalView } from "./goals.ts";
import { pendingAccessCount, pendingAccessRequests } from "./access.ts";

/** Doc as shown in lists (board, search). */
export interface DocSummary {
  id: string; type: Doc["type"]; state: Doc["state"]; title: string; author: string; authorId: string;
  buildingId: string | null; createdAt: string; updatedAt: string;
  verdict?: Doc["verdict"]; decision?: Doc["decision"]; requestStatus?: Doc["requestStatus"]; excerpt: string;
}

export function summarizeDoc(world: World, d: Doc): DocSummary {
  return {
    id: d.id, type: d.type, state: d.state, title: d.title, author: world.nameOf(d.authorId), authorId: d.authorId,
    buildingId: d.buildingId, createdAt: d.createdAt, updatedAt: d.updatedAt,
    ...(d.verdict ? { verdict: d.verdict } : {}), ...(d.decision ? { decision: d.decision } : {}),
    ...(d.requestStatus ? { requestStatus: d.requestStatus } : {}),
    excerpt: truncate(d.body.replace(/\s+/g, " ").trim(), 200),
  };
}

/** Insert a new doc (fills id/timestamps/defaults) and append `doc.created`. */
export function createDoc(world: World, fields: Omit<Partial<Doc>, "id" | "createdAt" | "updatedAt"> & Pick<Doc, "type" | "title" | "body" | "authorId" | "authorKind"> & { id?: string; createdAt?: string }, eventText?: string): Doc {
  const ts = nowIso();
  const doc = world.docs.upsert(Doc.parse({ state: "draft", ...fields, id: fields.id ?? newId("dc"), createdAt: fields.createdAt ?? ts, updatedAt: fields.createdAt ?? ts }));
  const agentId = doc.authorKind === "agent" ? doc.authorId : null;
  world.events.append({ type: "doc.created", agentId, buildingId: doc.buildingId, text: eventText ?? `${world.nameOf(doc.authorId)} wrote ${doc.type} "${doc.title}"`, payload: { docId: doc.id, docType: doc.type, state: doc.state } });
  return doc;
}

/** Patch a doc (bumps updatedAt). */
export function updateDoc(world: World, id: string, patch: Partial<Doc>): Doc {
  return world.docs.patch(id, { ...patch, updatedAt: nowIso() });
}

/** Whether `holder` may see the doc: drafts are private to their author. */
export function canSeeDoc(holder: Holder, d: Doc): boolean {
  return d.state !== "draft" || d.authorId === holder.id;
}

/**
 * A new pending assignment. `lane` (goal-directed budgets) is validated by `resolveLane`; left out, a continuation
 * (`fromAssignmentId`, or the assignment behind `fromReportId`) inherits its lane, else it is directed. `laneOverride`
 * skips the validation (system-made work such as the checkpoint assignment).
 */
export function createAssignment(world: World, a: { agentId: string; title: string; description: string; createdBy: Holder | { kind: "system"; id: string }; fromReportId?: string | null; fromMeetingId?: string | null; fromAssignmentId?: string | null; buildingId?: string; front?: boolean; waitFor?: WaitFor | null; parked?: number; lane?: LaneFields; laneOverride?: Lane; origin?: Origin | null; queue?: AssignmentQueue; model?: string | null }): Assignment {
  let agent = world.agents.require(a.agentId, "agent");
  let queue: AssignmentQueue = a.queue ?? "agent";
  // a fork lives for one session: work made for it (a park continuation, a review follow-up) goes on the building queue,
  // held by the manager until the next fork takes it
  if (agent.forkOf) { agent = world.agents.require(agent.forkOf, "agent"); queue = "building"; }
  const buildingId = a.buildingId ?? agent.homeBuildingId ?? agent.buildingId;
  if (!buildingId) throw new AppError("bad_request", `${agent.name} has no building to work in.`);
  const fromReport = a.fromReportId ? world.docs.get(a.fromReportId) : undefined;
  const fromId = a.fromAssignmentId ?? fromReport?.assignmentId ?? null;
  const from = fromId ? world.assignments.get(fromId) : undefined;
  const meeting = a.fromMeetingId ? world.meetings.get(a.fromMeetingId) : undefined;
  const lane = a.laneOverride ?? resolveLane(world, buildingId, a.createdBy, a.lane, { from, fromMeeting: !!a.fromMeetingId, humanMeetingId: meeting && meetingHadHuman(meeting) ? meeting.id : undefined });
  // wakes step 1: the human it traces to: given, else a human's own act (assign, decision, flag, 1:1), else what it continues
  const origin = a.origin !== undefined ? a.origin
    : a.createdBy.kind === "user" ? humanOrigin(a.createdBy.id, a.fromMeetingId ?? a.fromReportId ?? null)
    : fromReport?.authorKind === "user" ? humanOrigin(fromReport.authorId, fromReport.id)
    : (meeting && meetingOrigin(meeting)) ?? from?.origin ?? null;
  const ts = nowIso();
  const id = newId("as");
  const assignment = world.assignments.upsert({
    id, agentId: agent.id, buildingId, title: a.title, description: a.description, status: "pending",
    createdBy: a.createdBy.id, createdByKind: a.createdBy.kind === "system" ? "user" : a.createdBy.kind,
    fromMeetingId: a.fromMeetingId ?? null, fromReportId: a.fromReportId ?? null, reportId: null,
    fromAssignmentId: a.fromAssignmentId ?? null, position: a.front ? frontPosition(world, agent.id) : Date.now(), createdAt: ts, updatedAt: ts,
    waitFor: a.waitFor ?? null, ...(a.parked ? { parked: a.parked } : {}), ...lane, heldReason: null, origin,
    // the chain is the first assignment's id: a retry, a park continuation and a review follow-up continue `from`'s
    chainId: from ? from.chainId ?? from.id : id, queue, model: a.model ?? null,
    // v1.4: a visitor's loop runs outside the town, so its assignments are offers it accepts (never scheduled)
    ...(agent.kind === "visitor" ? { offered: true } : {}),
  });
  world.events.append({ type: "assignment.created", agentId: agent.id, buildingId, text: `${assignment.offered ? "Offered to" : "New assignment for"} ${agent.name}: ${a.title}${assignment.waitFor ? ` (waits on ${describeWait(world, assignment.waitFor)})` : ""}`, payload: { assignmentId: assignment.id, chainId: assignment.chainId, queue, lane: assignment.lane, grantId: assignment.grantId, offered: !!assignment.offered, waitFor: assignment.waitFor, createdBy: a.createdBy.id, fromReportId: a.fromReportId ?? null, fromMeetingId: a.fromMeetingId ?? null, origin } });
  return assignment;
}

/** The agent's pending assignments in queue order (the scheduler runs the first). */
export function pendingQueue(world: World, agentId: string): Assignment[] {
  return world.assignments.where("agentId = ? AND status = 'pending'", [agentId], QUEUE_ORDER);
}

/** The pending assignment the scheduler runs next for this agent (offers to visitors never run; nor do waiting ones). */
export function nextPending(world: World, agentId: string): Assignment | undefined {
  return world.assignments.first(`agentId = ? AND status = 'pending' AND (offered IS NULL OR offered = 0) AND waitFor IS NULL${ownQueue(world, agentId)}`, [agentId], QUEUE_ORDER);
}

/** Building-queue work held by the manager waits for a fork; a fork runs the building-queue assignment it took. */
const ownQueue = (world: World, agentId: string) => world.agents.get(agentId)?.forkOf ? "" : " AND queue = 'agent'";

/** Manager forks: the building's queue (pending, `queue = 'building'`, not yet taken by a fork) in queue order, waiting ones included. */
export function buildingQueue(world: World, buildingId: string): Assignment[] {
  return world.assignments.where("buildingId = ? AND status = 'pending' AND queue = 'building' AND agentId IN (SELECT id FROM agents WHERE forkOf IS NULL)", [buildingId], QUEUE_ORDER);
}

/**
 * The assignment the scheduler starts next: the first runnable pending one (as `nextPending`) that `Budget.canStart`
 * lets through. Ones the lane gate holds stay pending with their `heldReason` and are skipped, so a held grant task
 * doesn't block exploration queued behind it. Undefined when nothing can start (or the agent is out of budget).
 */
export function nextStartable(world: World, agentId: string): Assignment | undefined {
  if (!world.budget.canStart(agentId)) return undefined;
  return world.assignments.where(`agentId = ? AND status = 'pending' AND (offered IS NULL OR offered = 0) AND waitFor IS NULL${ownQueue(world, agentId)}`, [agentId], QUEUE_ORDER)
    .find((a) => world.budget.canStart(agentId, a));
}

/** A position ahead of every pending assignment of the agent (except `exceptId`). */
function frontPosition(world: World, agentId: string, exceptId?: string): number {
  const row = world.db.prepare("SELECT MIN(position) AS p FROM assignments WHERE agentId = ? AND status = 'pending' AND id IS NOT ?").get(agentId, exceptId ?? null) as { p: number | null };
  return row.p === null ? Date.now() : row.p - 1;
}

/** Put a pending assignment at the front of its agent's queue. */
export function moveToFront(world: World, id: string): Assignment {
  const a = world.assignments.require(id, "assignment");
  if (a.status !== "pending") throw new AppError("conflict", `Assignment "${a.title}" is ${a.status}, not queued.`);
  const head = nextPending(world, a.agentId);
  if (head?.id === a.id) return a;
  return world.assignments.upsert({ ...a, position: frontPosition(world, a.agentId, a.id), updatedAt: nowIso() });
}

export function setAssignmentStatus(world: World, id: string, status: Assignment["status"], extra: Partial<Assignment> = {}): Assignment {
  const cur = world.assignments.require(id, "assignment");
  if (cur.status !== status && (cur.status === "done" || cur.status === "cancelled")) throw new AppError("conflict", `Assignment "${cur.title}" is already ${cur.status}.`);
  const a = world.assignments.upsert({ ...cur, ...extra, status, updatedAt: nowIso() });
  if (cur.status !== status) world.events.append({ type: "assignment.status", agentId: a.agentId, buildingId: a.buildingId, text: `Assignment "${a.title}" is ${status}`, payload: { assignmentId: id, status, from: cur.status } });
  return a;
}

/** `id` may be given (a human's tell stamps an origin via its own message id); `origin` defaults to none. */
export function sendMessage(world: World, m: Omit<Message, "id" | "createdAt" | "readAt" | "meetingId" | "docId" | "origin"> & { id?: string; meetingId?: string | null; docId?: string | null; origin?: Origin | null }): Message {
  return world.messages.upsert({ meetingId: null, docId: null, origin: null, ...m, id: m.id ?? newId("ms"), createdAt: nowIso(), readAt: null });
}

/** "Proposal for next session" section → {title, text}. */
export function extractProposal(body: string): { title: string; text: string } | null {
  const text = extractSection(body, /proposal/i);
  if (!text) return null;
  const title = firstLine(text);
  return title ? { title, text } : null;
}

const DECISION_VERB: Record<ReviewDecision, string> = { approve: "Acknowledged", continue: "Continued", redirect: "Redirected", stop: "Stopped" };

/**
 * Apply a decision to a pending report (hub semantics). Every decision acknowledges the report.
 * - approve: nothing else; no assignment.
 * - continue: next assignment from the report's Proposal section (note appended).
 * - redirect: next assignment from the note (required); the proposal is appended as context.
 * - stop: author stopped; its pending/active assignments cancelled.
 * `opts.lane` sets the next assignment's lane (as `assign`; e.g. directed with the human source); left out it inherits.
 * Shared by the `review` verb, REST, the auto policy, and meeting decisions.
 */
export function applyDecision(world: World, docId: string, decision: ReviewDecision, note: string, decider: Holder | { kind: "system"; id: string }, opts: { waitFor?: WaitFor | null; assigneeId?: string | null; lane?: LaneFields } = {}): { doc: Doc; assignment: Assignment | null } {
  note = note.trim();
  if (decision === "redirect" && !note) throw new AppError("bad_request", "Redirect needs a note: it becomes the next assignment.");
  const report = world.docs.require(docId, "doc");
  if (report.type === "flag") return decideFlag(world, report, decision, note, decider, opts);
  const doc = updateDoc(world, docId, { decision, decisionNote: note || undefined, decidedBy: decider.id, decidedAt: nowIso() });
  const author = world.agents.get(report.authorId);
  world.events.append({ type: "doc.decision", agentId: author?.id ?? null, buildingId: doc.buildingId, text: `${DECISION_VERB[decision]}: "${doc.title}"${note ? ` (${truncate(note, 80)})` : ""}`, payload: { docId, decision, note, decidedBy: decider.id } });
  let assignment: Assignment | null = null;
  if (!author || decision === "approve") return { doc, assignment };
  if (decision === "stop") {
    for (const a of world.assignments.where("agentId = ? AND status IN ('pending','active')", [author.id])) setAssignmentStatus(world, a.id, "cancelled");
    if (author.currentAssignmentId) world.agents.patch(author.id, { currentAssignmentId: null });
    world.setStatus(author.id, "stopped", `${author.name} was stopped after review`);
    return { doc, assignment };
  }
  // P2: a parked report (its author queued its own continuation with `resumeWhen`). Approve leaves it parked (it
  // resumes by itself); Continue resumes it now; Redirect cancels it for the note.
  const parked = world.assignments.first("fromReportId = ? AND status = 'pending' AND parked IS NOT NULL", [docId], "ORDER BY createdAt");
  if (parked && decision === "continue") {
    assignment = world.assignments.upsert({ ...parked, waitFor: opts.waitFor ?? null, description: note ? `${parked.description}\n\nManager's note: ${note}` : parked.description, updatedAt: nowIso() });
    if (author.status === "stopped") world.setStatus(author.id, "idle");
    return { doc, assignment };
  }
  if (parked) setAssignmentStatus(world, parked.id, "cancelled");
  const proposal = extractProposal(report.body);
  let title: string, description: string;
  if (decision === "continue") {
    title = proposal?.title ?? `Continue: ${report.title}`;
    description = [
      proposal ? `Proposal from your report "${report.title}":\n\n${proposal.text}` : `Continue from your report "${report.title}" (${report.id}); it had no Proposal section.`,
      ...(note ? [`Manager's note: ${note}`] : []),
    ].join("\n\n");
  } else {
    title = truncate(firstLine(note) || note, 120);
    description = [
      `Your manager redirected you after your report "${report.title}" (${report.id}):\n\n${note}`,
      ...(proposal ? [`For context, your report proposed:\n\n${proposal.text}`] : []),
    ].join("\n\n");
  }
  assignment = createAssignment(world, { agentId: author.id, title, description, createdBy: decider, fromReportId: report.id, waitFor: opts.waitFor, lane: opts.lane });
  if (author.status === "stopped") world.setStatus(author.id, "idle");
  return { doc, assignment };
}

// ---- flags (town hall 2026-10-25 evening, decision 3) ----

/**
 * A human plants a flag in a building: a short note (its first line is the title) that lands in the building's in-tray
 * as a pending `flag` doc, where the manager delegates it (`applyDecision` → `decideFlag`). Needs `building.assign` on
 * that building and a human actor: agents assign work directly. Nothing else routes it (no nearest-manager logic).
 */
export function plantFlag(world: World, actor: Agent, buildingId: string, text: string): Doc {
  const building = world.buildings.require(buildingId, "building");
  if (building.kind === "town-hall") throw new AppError("bad_request", "Plant the flag in a building, not the Town Hall: it has no manager to delegate it.");
  if (actor.kind !== "human") throw new AppError("forbidden", "Only a human plants a flag; as an agent, give the work with `assign`.");
  world.permissions.require(actor, "building.assign", buildingId);
  const body = text.trim();
  if (!body) throw new AppError("bad_request", "A flag needs a note: what you want done.");
  const holder = world.holderOf(actor);
  // it stands where the planter stands (dc_r40dq3znse), until the building's manager walks there and picks it up
  const flagPos = world.layout.isWalkable(actor.pos.x, actor.pos.y) ? { x: actor.pos.x, y: actor.pos.y } : undefined;
  return createDoc(world, {
    type: "flag", state: "building", title: truncate(firstLine(body) || body, 120), body, decision: "pending",
    authorId: holder.id, authorKind: holder.kind, buildingId, flagPos,
  }, `${actor.name} planted a flag in ${building.name}: ${truncate(firstLine(body) || body, 80)}`);
}

/** The place id an agent walks to (`go`) to pick up a flag standing on the map. */
export const flagPlaceId = (docId: string) => `flag:${docId}`;

/**
 * An agent arrived on a flag's tile (`go flag:<id>`). The building's manager (any agent with building.review there) picks it up: it leaves the map (the
 * in-tray entry stays as the record) and the manager gets its text to read. Anyone else just stands by it.
 */
export function pickUpFlag(world: World, me: Agent, flag: Doc): { pickedUp: boolean; flag: { id: string; title: string; body: string; by: string; buildingId: string | null }; note?: string } {
  const view = { id: flag.id, title: flag.title, body: flag.body, by: world.nameOf(flag.authorId), buildingId: flag.buildingId };
  if (flag.pickedUpAt) return { pickedUp: false, flag: view, note: `${world.nameOf(flag.pickedUpBy ?? "")} already picked it up.` };
  // whoever decides the building's in-tray picks it up: its manager agent, or an agent holding building.review there
  if (!flag.buildingId || !world.permissions.can(me, "building.review", flag.buildingId)) {
    const b = flag.buildingId ? world.buildings.get(flag.buildingId) : undefined;
    const manager = b ? managerAgentOf(world, b) : undefined;
    return { pickedUp: false, flag: view, note: `Only ${manager ? manager.name : "the building's manager"} picks this flag up.` };
  }
  const doc = updateDoc(world, flag.id, { pickedUpAt: nowIso(), pickedUpBy: me.id });
  world.events.append({ type: "doc.updated", agentId: me.id, buildingId: doc.buildingId, text: `${me.name} picked up ${view.by}'s flag: ${truncate(doc.title, 80)}`, payload: { docId: doc.id, flagPickedUp: true } });
  return { pickedUp: true, flag: view, note: "Picked up. Now delegate it with `review` (continue or redirect with assigneeId), or approve it if nothing needs doing." };
}

/**
 * Decide a flag. approve = handled, no assignment. continue = the flag's note becomes a directed assignment verbatim;
 * redirect = the decider's note does, with the flag as context. It goes to the building queue (a fork of the manager
 * runs it); `assigneeId` names only the manager itself or a visitor homed in the building (1:1 mt_wngibcr98b decision 1:
 * no standing residents). The lane is directed in any building: a human asked for it, as with a meeting decision. stop
 * has no agent to stop.
 */
function decideFlag(world: World, flag: Doc, decision: ReviewDecision, note: string, decider: Holder | { kind: "system"; id: string }, opts: { waitFor?: WaitFor | null; assigneeId?: string | null }): { doc: Doc; assignment: Assignment | null } {
  if (decision === "stop") throw new AppError("bad_request", "A flag has no agent to stop: approve it (handled), or continue/redirect it (the building queue).");
  // an agent (the manager) walks to a flag standing on the map and picks it up before deciding it; a human decides from the in-tray
  if (decider.kind === "agent" && flag.flagPos && !flag.pickedUpAt) throw new AppError("bad_request", `Pick the flag up first: it stands on the map at (${flag.flagPos.x}, ${flag.flagPos.y}). \`go\` to ${flagPlaceId(flag.id)}, read it, then decide it.`);
  let assignee: Agent | undefined;
  let queue: "building" | undefined;
  if (decision !== "approve") {
    const building = world.buildings.get(flag.buildingId ?? "");
    const manager = managerAgentOf(world, building);
    if (!opts.assigneeId) {
      if (!manager) throw new AppError("bad_request", `${building?.name ?? "The building"} has no manager agent to fork: approve the flag, or name a visitor of the building (assigneeId).`);
      assignee = manager;
      queue = "building";
    } else {
      assignee = world.agents.require(opts.assigneeId, "agent");
      const home = assignee.homeBuildingId ?? assignee.buildingId;
      if (assignee.kind === "human" || home !== flag.buildingId || (assignee.id !== manager?.id && assignee.kind !== "visitor")) throw new AppError("bad_request", `${assignee.name} can't take the flag: leave assigneeId out to queue it to ${building?.name ?? "the building"} (a fork of the manager runs it), or name the manager itself or a visitor of the building.`);
      if (assignee.status === "retired" || assignee.status === "banned") throw new AppError("bad_request", `${assignee.name} is ${assignee.status} and can't take the flag.`);
    }
  }
  const doc = updateDoc(world, flag.id, { decision, decisionNote: note || undefined, decidedBy: decider.id, decidedAt: nowIso() });
  world.events.append({ type: "doc.decision", agentId: assignee?.id ?? null, buildingId: doc.buildingId, text: `${DECISION_VERB[decision]} flag "${doc.title}"${assignee ? ` → ${assignee.name}` : ""}${note ? ` (${truncate(note, 80)})` : ""}`, payload: { docId: flag.id, decision, note, decidedBy: decider.id, assigneeId: assignee?.id ?? null } });
  if (!assignee) return { doc, assignment: null };
  const by = world.nameOf(flag.authorId);
  const title = decision === "continue" ? flag.title : truncate(firstLine(note) || note, 120);
  const description = decision === "continue"
    ? `${by} planted a flag in your building (${flag.id}):\n\n${flag.body}${note ? `\n\nYour manager's note: ${note}` : ""}`
    : `Your manager ${world.nameOf(decider.id)} gave you ${by}'s flag (${flag.id}):\n\n${note}\n\nThe flag said:\n\n${flag.body}`;
  const assignment = createAssignment(world, { agentId: assignee.id, title, description, createdBy: decider, fromReportId: flag.id, waitFor: opts.waitFor, laneOverride: DIRECTED, ...(queue ? { queue } : {}) });
  if (!queue) sendMessage(world, { kind: "system", fromId: decider.id, fromKind: "system", toId: assignee.id, body: `New assignment from ${world.nameOf(decider.id)} (${by}'s flag): ${title}${opts.waitFor ? ` (starts after ${describeWait(world, opts.waitFor)})` : ""}` });
  if (assignee.status === "stopped") world.setStatus(assignee.id, "idle");
  return { doc, assignment };
}

/**
 * The building's manager agent, if it can work: the resident set as `managerAgentId` unless it is stopped, banned or
 * retired. A building with one has its in-tray worked by the manager; otherwise humans holding `building.review` do
 * (town hall 2026-10-24, decision 1a: no review-policy setting). Never the Town Hall's: its manager is the Planner
 * (`Reorgs.ensurePlanner`), which only answers 1:1s and facilitates reorgs; the Town Hall in-tray is the humans'.
 */
export function managerAgentOf(world: World, building: Building | undefined): Agent | undefined {
  if (!building?.managerAgentId || building.kind === "town-hall") return undefined;
  const a = world.agents.get(building.managerAgentId);
  return a && a.kind !== "human" && a.status !== "stopped" && a.status !== "banned" && a.status !== "retired" ? a : undefined;
}

/** Who works this building's in-tray right now. */
export function intrayWorker(world: World, building: Building | undefined): "manager" | "human" {
  return managerAgentOf(world, building) ? "manager" : "human";
}

/**
 * A team-lead report is for the humans: a rollup (which a checkpoint report also is, tagged `rollup` by `submit_report`)
 * lands in the Town Hall in-tray. Routed by what the report is, not by who wrote it (town hall 2026-10-25, decision 6):
 * a manager's own work report, from an assignment it gave itself or got from a meeting, is an ordinary report in its
 * building's in-tray, which the manager decides in its next team-lead session and folds into its rollup. An unhomed
 * visitor's report (tagged `visitor`, filed under the Town Hall) is one too: the humans work it.
 */
export function isTownHallItem(world: World, doc: Doc): boolean {
  if (doc.type !== "report" || !doc.buildingId) return false;
  const b = world.buildings.get(doc.buildingId);
  if (!b) return false;
  // an unhomed visitor's report is filed under the Town Hall itself (submit_report): the humans work it
  if (doc.tags.includes("visitor")) return b.kind === "town-hall";
  return doc.tags.includes("rollup") && b.kind !== "town-hall";
}

const GRANT_INTRAY_STATUSES = ["proposed", "countered", "checkpoint"] as const;

/**
 * The building's in-tray: pending reports, oldest first. For the Town Hall: every building's pending rollups and
 * checkpoint reports; for a lab: its pending work reports, the manager's own included (its rollups go to the Town Hall),
 * and the flags humans planted there (`plantFlag`).
 */
export function intrayOf(world: World, buildingId: string): Doc[] {
  const b = world.buildings.get(buildingId);
  if (b?.kind === "town-hall") {
    return world.docs.where("type = 'report' AND decision = 'pending' AND buildingId IS NOT NULL", [], "ORDER BY createdAt, rowid").filter((d) => isTownHallItem(world, d));
  }
  return world.docs.where("type IN ('report', 'flag') AND decision = 'pending' AND buildingId = ?", [buildingId], "ORDER BY createdAt, rowid").filter((d) => !isTownHallItem(world, d));
}

/**
 * Grants a human must decide on, every building, oldest first: Town Hall in-tray rows. Proposed, countered and checkpoint
 * grants, and grants the manager closed as done (`close_grant`) whose key result is still claimed: the human marks it met
 * or missed, and the row leaves.
 */
export function grantsAwaitingDecision(world: World): GrantView[] {
  return world.grants.where(
    `status IN (${GRANT_INTRAY_STATUSES.map((s) => `'${s}'`).join(", ")}) OR (status = 'closed' AND outcome = 'done' AND keyResultId IN (SELECT id FROM key_results WHERE status = 'claimed'))`,
    [], "ORDER BY updatedAt, rowid",
  ).map((g) => world.grantDesk.view(g));
}

/** The Town Hall in-tray: managers' rollups and checkpoint reports, grants awaiting a human's decision, people asking to join, and blocked buildings (not counted in the badge). */
export function townHallIntray(world: World): { reports: Doc[]; grants: GrantView[]; goalProposals: GoalProposalView[]; access: AccessRequestView[]; blocked: BlockedBuilding[] } {
  const th = world.buildings.first("kind = 'town-hall'");
  return { reports: th ? intrayOf(world, th.id) : [], grants: grantsAwaitingDecision(world), goalProposals: world.goalTree.listProposals({ status: "open" }), access: pendingAccessRequests(world), blocked: world.grantDesk.blockedBuildings() };
}

/** Open goal proposals (propose_goal / propose_key_result): Town Hall in-tray items a human accepts or cuts (docs/goals.md step 4). */
const openGoalProposals = (world: World) => world.goalProposals.count("status = 'open'");

/** In-tray size as the badge shows it: pending items of that in-tray (the Town Hall's counts its grants and access requests too). */
export function intrayCount(world: World, buildingId: string): number {
  const b = world.buildings.get(buildingId);
  return intrayOf(world, buildingId).length + (b?.kind === "town-hall" ? grantsAwaitingDecision(world).length + openGoalProposals(world) + pendingAccessCount(world) : 0);
}

/**
 * In-tray counts by building id (buildings with none are absent). Rollups count for the Town Hall. Each count is
 * `intrayCount` of that building: exactly the items its in-tray lists. A pending report or flag filed under the Town Hall
 * that is not a Town Hall item (not a visitor's report: none is made today, `plantFlag` refuses the Town Hall) is listed
 * nowhere, so it counts nowhere.
 */
export function intrayCounts(world: World): Map<string, number> {
  const th = world.buildings.first("kind = 'town-hall'");
  const counts = new Map<string, number>();
  const bump = (id: string) => counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const d of world.docs.where("type IN ('report', 'flag') AND decision = 'pending' AND buildingId IS NOT NULL")) {
    if (isTownHallItem(world, d)) { if (th) bump(th.id); } else if (d.buildingId !== th?.id) bump(d.buildingId!);
  }
  if (th) for (let i = grantsAwaitingDecision(world).length + openGoalProposals(world) + pendingAccessCount(world); i > 0; i--) bump(th.id);
  return counts;
}

/** Pending report (or flag) check used by the review paths. */
export function requirePendingReport(world: World, docId: string): Doc {
  const doc = world.docs.require(docId, "doc");
  if (doc.type !== "report" && doc.type !== "flag") throw new AppError("bad_request", `Doc ${docId} is a ${doc.type}, not a report or a flag.`);
  if (doc.decision !== "pending") throw new AppError("conflict", `Report already decided (${doc.decision}).`);
  return doc;
}

export function homeOf(agent: Agent): string | null {
  return agent.homeBuildingId ?? agent.buildingId;
}
