import { Doc, type Agent, type Assignment, type Message } from "@agent-town/schema";
import { AppError } from "./errors.ts";
import type { Holder } from "./permissions.ts";
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

export function createAssignment(world: World, a: { agentId: string; title: string; description: string; createdBy: Holder | { kind: "system"; id: string }; fromReportId?: string | null; fromMeetingId?: string | null; buildingId?: string }): Assignment {
  const agent = world.agents.require(a.agentId, "agent");
  const buildingId = a.buildingId ?? agent.homeBuildingId ?? agent.buildingId;
  if (!buildingId) throw new AppError("bad_request", `${agent.name} has no building to work in.`);
  const ts = nowIso();
  const assignment = world.assignments.upsert({
    id: newId("as"), agentId: agent.id, buildingId, title: a.title, description: a.description, status: "pending",
    createdBy: a.createdBy.id, createdByKind: a.createdBy.kind === "system" ? "user" : a.createdBy.kind,
    fromMeetingId: a.fromMeetingId ?? null, fromReportId: a.fromReportId ?? null, reportId: null, createdAt: ts, updatedAt: ts,
  });
  world.events.append({ type: "assignment.created", agentId: agent.id, buildingId, text: `New assignment for ${agent.name}: ${a.title}`, payload: { assignmentId: assignment.id, createdBy: a.createdBy.id, fromReportId: a.fromReportId ?? null, fromMeetingId: a.fromMeetingId ?? null } });
  return assignment;
}

export function setAssignmentStatus(world: World, id: string, status: Assignment["status"], extra: Partial<Assignment> = {}): Assignment {
  const cur = world.assignments.require(id, "assignment");
  const a = world.assignments.upsert({ ...cur, ...extra, status, updatedAt: nowIso() });
  if (cur.status !== status) world.events.append({ type: "assignment.status", agentId: a.agentId, buildingId: a.buildingId, text: `Assignment "${a.title}" is ${status}`, payload: { assignmentId: id, status, from: cur.status } });
  return a;
}

export function sendMessage(world: World, m: Omit<Message, "id" | "createdAt" | "readAt" | "meetingId"> & { meetingId?: string | null }): Message {
  return world.messages.upsert({ meetingId: null, ...m, id: newId("ms"), createdAt: nowIso(), readAt: null });
}

/** "Proposal for next session" section → {title, text}. */
export function extractProposal(body: string): { title: string; text: string } | null {
  const text = extractSection(body, /proposal/i);
  if (!text) return null;
  const title = firstLine(text);
  return title ? { title, text } : null;
}

/**
 * Apply a review decision to a pending report. approve/redirect → next assignment from the
 * report's Proposal section; stop → author stopped. Shared by the `review` verb, REST, and auto policy.
 */
export function applyDecision(world: World, docId: string, decision: "approve" | "redirect" | "stop", note: string, decider: Holder | { kind: "system"; id: string }): { doc: Doc; assignment: Assignment | null } {
  const report = world.docs.require(docId, "doc");
  const doc = updateDoc(world, docId, { decision, decisionNote: note || undefined, decidedBy: decider.id, decidedAt: nowIso() });
  const author = world.agents.get(report.authorId);
  world.events.append({ type: "doc.decision", agentId: author?.id ?? null, buildingId: doc.buildingId, text: `${decision === "approve" ? "Approved" : decision === "redirect" ? "Redirected" : "Stopped"}: "${doc.title}"${note ? ` (${truncate(note, 80)})` : ""}`, payload: { docId, decision, note, decidedBy: decider.id } });
  let assignment: Assignment | null = null;
  if (!author) return { doc, assignment };
  if (decision === "stop") {
    world.setStatus(author.id, "stopped", `${author.name} was stopped after review`);
  } else {
    const proposal = extractProposal(report.body);
    const title = proposal?.title ?? `Continue: ${report.title}`;
    const parts: string[] = [];
    if (decision === "redirect" && note) parts.push(`Reviewer redirect: ${note}`);
    parts.push(proposal ? `Proposal from your report "${report.title}":\n\n${proposal.text}` : `Continue from your report "${report.title}" (${report.id}); it had no Proposal section.`);
    if (decision === "approve" && note) parts.push(`Reviewer note: ${note}`);
    assignment = createAssignment(world, { agentId: author.id, title, description: parts.join("\n\n"), createdBy: decider, fromReportId: report.id });
    if (author.status === "awaiting-review" || author.status === "stopped") world.setStatus(author.id, "idle");
  }
  return { doc, assignment };
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
