import { Doc, QUEUE_ORDER, type Agent, type Assignment, type Building, type GrantView, type Message, type ReviewDecision, type WaitFor } from "@muster-town/schema";
import { AppError } from "./errors.ts";
import type { Holder } from "./permissions.ts";
import { describeWait } from "./waits.ts";
import { extractSection, firstLine, newId, nowIso, truncate } from "./util.ts";
import type { World } from "./world.ts";

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

export function createAssignment(world: World, a: { agentId: string; title: string; description: string; createdBy: Holder | { kind: "system"; id: string }; fromReportId?: string | null; fromMeetingId?: string | null; fromAssignmentId?: string | null; buildingId?: string; front?: boolean; waitFor?: WaitFor | null; parked?: number }): Assignment {
  const agent = world.agents.require(a.agentId, "agent");
  const buildingId = a.buildingId ?? agent.homeBuildingId ?? agent.buildingId;
  if (!buildingId) throw new AppError("bad_request", `${agent.name} has no building to work in.`);
  const ts = nowIso();
  const assignment = world.assignments.upsert({
    id: newId("as"), agentId: agent.id, buildingId, title: a.title, description: a.description, status: "pending",
    createdBy: a.createdBy.id, createdByKind: a.createdBy.kind === "system" ? "user" : a.createdBy.kind,
    fromMeetingId: a.fromMeetingId ?? null, fromReportId: a.fromReportId ?? null, reportId: null,
    fromAssignmentId: a.fromAssignmentId ?? null, position: a.front ? frontPosition(world, agent.id) : Date.now(), createdAt: ts, updatedAt: ts,
    waitFor: a.waitFor ?? null, ...(a.parked ? { parked: a.parked } : {}),
    // v1.4: a visitor's loop runs outside the town, so its assignments are offers it accepts (never scheduled)
    ...(agent.kind === "visitor" ? { offered: true } : {}),
  });
  world.events.append({ type: "assignment.created", agentId: agent.id, buildingId, text: `${assignment.offered ? "Offered to" : "New assignment for"} ${agent.name}: ${a.title}${assignment.waitFor ? ` (waits on ${describeWait(world, assignment.waitFor)})` : ""}`, payload: { assignmentId: assignment.id, offered: !!assignment.offered, waitFor: assignment.waitFor, createdBy: a.createdBy.id, fromReportId: a.fromReportId ?? null, fromMeetingId: a.fromMeetingId ?? null } });
  return assignment;
}

/** The agent's pending assignments in queue order (the scheduler runs the first). */
export function pendingQueue(world: World, agentId: string): Assignment[] {
  return world.assignments.where("agentId = ? AND status = 'pending'", [agentId], QUEUE_ORDER);
}

/** The pending assignment the scheduler runs next for this agent (offers to visitors never run; nor do waiting ones). */
export function nextPending(world: World, agentId: string): Assignment | undefined {
  return world.assignments.first("agentId = ? AND status = 'pending' AND (offered IS NULL OR offered = 0) AND waitFor IS NULL", [agentId], QUEUE_ORDER);
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

export function sendMessage(world: World, m: Omit<Message, "id" | "createdAt" | "readAt" | "meetingId" | "docId"> & { meetingId?: string | null; docId?: string | null }): Message {
  return world.messages.upsert({ meetingId: null, docId: null, ...m, id: newId("ms"), createdAt: nowIso(), readAt: null });
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
 * Shared by the `review` verb, REST, the auto policy, and meeting decisions.
 */
export function applyDecision(world: World, docId: string, decision: ReviewDecision, note: string, decider: Holder | { kind: "system"; id: string }, opts: { waitFor?: WaitFor | null } = {}): { doc: Doc; assignment: Assignment | null } {
  note = note.trim();
  if (decision === "redirect" && !note) throw new AppError("bad_request", "Redirect needs a note: it becomes the next assignment.");
  const report = world.docs.require(docId, "doc");
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
  assignment = createAssignment(world, { agentId: author.id, title, description, createdBy: decider, fromReportId: report.id, waitFor: opts.waitFor });
  if (author.status === "stopped") world.setStatus(author.id, "idle");
  return { doc, assignment };
}

/**
 * The building's manager agent, if it can work: the resident set as `managerAgentId` unless it is stopped, banned or
 * retired. A building with one has its in-tray worked by the manager; otherwise humans holding `building.review` do
 * (town hall 2026-10-24, decision 1a: no review-policy setting).
 */
export function managerAgentOf(world: World, building: Building | undefined): Agent | undefined {
  if (!building?.managerAgentId) return undefined;
  const a = world.agents.get(building.managerAgentId);
  return a && a.kind !== "human" && a.status !== "stopped" && a.status !== "banned" && a.status !== "retired" ? a : undefined;
}

/** Who works this building's in-tray right now. */
export function intrayWorker(world: World, building: Building | undefined): "manager" | "human" {
  return managerAgentOf(world, building) ? "manager" : "human";
}

/**
 * A report by a building's manager agent is for the humans: it lands in the Town Hall in-tray (rollups, checkpoints,
 * escalations, replies to a human's message), never in the building in-tray the manager itself works.
 */
export function isTownHallItem(world: World, doc: Doc): boolean {
  if (doc.type !== "report" || !doc.buildingId) return false;
  const b = world.buildings.get(doc.buildingId);
  return !!b && b.kind !== "town-hall" && b.managerAgentId === doc.authorId;
}

const GRANT_INTRAY_STATUSES = ["proposed", "countered", "checkpoint"] as const;

/**
 * The building's in-tray: pending reports, oldest first. For the Town Hall: the pending reports of every building's
 * manager agent (rollups and the like); for a lab: its residents' pending reports (the manager's own go to the Town Hall).
 */
export function intrayOf(world: World, buildingId: string): Doc[] {
  const b = world.buildings.get(buildingId);
  if (b?.kind === "town-hall") {
    return world.docs.where("type = 'report' AND decision = 'pending' AND buildingId IS NOT NULL", [], "ORDER BY createdAt, rowid").filter((d) => isTownHallItem(world, d));
  }
  return world.docs.where("type = 'report' AND decision = 'pending' AND buildingId = ?", [buildingId], "ORDER BY createdAt, rowid").filter((d) => !isTownHallItem(world, d));
}

/** Grants a human must decide on (proposed, countered, at a checkpoint), every building, oldest first: Town Hall in-tray rows. */
export function grantsAwaitingDecision(world: World): GrantView[] {
  return world.grants.where(`status IN (${GRANT_INTRAY_STATUSES.map((s) => `'${s}'`).join(", ")})`, [], "ORDER BY updatedAt, rowid").map((g) => world.grantDesk.view(g));
}

/** The Town Hall in-tray: manager reports (rollups, checkpoints, escalations) plus grants awaiting a human's decision. */
export function townHallIntray(world: World): { reports: Doc[]; grants: GrantView[] } {
  const th = world.buildings.first("kind = 'town-hall'");
  return { reports: th ? intrayOf(world, th.id) : [], grants: grantsAwaitingDecision(world) };
}

/** In-tray size as the badge shows it: pending items of that in-tray (the Town Hall's counts its grants too). */
export function intrayCount(world: World, buildingId: string): number {
  const b = world.buildings.get(buildingId);
  return intrayOf(world, buildingId).length + (b?.kind === "town-hall" ? grantsAwaitingDecision(world).length : 0);
}

/** In-tray counts by building id (buildings with none are absent). Manager reports count for the Town Hall. */
export function intrayCounts(world: World): Map<string, number> {
  const th = world.buildings.first("kind = 'town-hall'");
  const counts = new Map<string, number>();
  const bump = (id: string) => counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const d of world.docs.where("type = 'report' AND decision = 'pending' AND buildingId IS NOT NULL")) {
    if (isTownHallItem(world, d)) { if (th) bump(th.id); } else bump(d.buildingId!);
  }
  if (th) for (let i = grantsAwaitingDecision(world).length; i > 0; i--) bump(th.id);
  return counts;
}

/** Pending report check used by the review paths. */
export function requirePendingReport(world: World, docId: string): Doc {
  const doc = world.docs.require(docId, "doc");
  if (doc.type !== "report") throw new AppError("bad_request", `Doc ${docId} is a ${doc.type}, not a report.`);
  if (doc.decision !== "pending") throw new AppError("conflict", `Report already decided (${doc.decision}).`);
  return doc;
}

export function homeOf(agent: Agent): string | null {
  return agent.homeBuildingId ?? agent.buildingId;
}
