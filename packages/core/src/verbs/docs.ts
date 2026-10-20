import { BOARD_TYPES, type Agent, type Doc } from "@muster-town/schema";
import {
  applyDecision, canSeeDoc, createAssignment, createDoc, homeOf, requirePendingReport, sendMessage,
  setAssignmentStatus, summarizeDoc, updateDoc,
} from "../domain.ts";
import { AppError, badRequest, forbidden } from "../errors.ts";
import { docWhere, notifyMentions } from "../mentions.ts";
import { notebookOf } from "../prompts.ts";
import { describeWait, validateWait } from "../waits.ts";
import type { World } from "../world.ts";
import type { VerbIn } from "./types.ts";

const WRITE_FORBIDDEN_TYPES = new Set<Doc["type"]>(["report", "request", "human-report", "meeting-notes"]);

export async function board(world: World, me: Agent, input: VerbIn<"board">) {
  const bid = input.buildingId ?? me.buildingId ?? me.homeBuildingId;
  if (!bid) throw badRequest("You're not in a building; pass buildingId.");
  const b = world.buildings.require(bid, "building");
  const docs = boardDocs(world, bid, input.limit);
  return { building: { id: b.id, name: b.name, goal: b.goal }, docs: docs.map((d) => summarizeDoc(world, d)) };
}

const BOARD_SQL = BOARD_TYPES.map((t) => `'${t}'`).join(", ");

/** The building board: building-wide FYIs published to the building. Everything else is filed in the cabinet. */
export function boardDocs(world: World, buildingId: string, limit: number): Doc[] {
  return world.docs.where(`buildingId = ? AND state = 'building' AND type IN (${BOARD_SQL})`, [buildingId], `ORDER BY updatedAt DESC, rowid DESC LIMIT ${limit}`);
}

/** The building's filing cabinet: everything it has published that isn't a board FYI (reports, meeting notes, articles, notes…), newest first. */
export function cabinetDocs(world: World, buildingId: string, limit: number, filter: { type?: Doc["type"]; authorId?: string } = {}): Doc[] {
  const where = [`buildingId = ? AND state != 'draft' AND type NOT IN (${BOARD_SQL})`];
  const params: unknown[] = [buildingId];
  if (filter.type) { where.push("type = ?"); params.push(filter.type); }
  if (filter.authorId) { where.push("authorId = ?"); params.push(filter.authorId); }
  return world.docs.where(where.join(" AND "), params, `ORDER BY createdAt DESC, rowid DESC LIMIT ${limit}`);
}

/** How many docs the cabinet holds per (type, author): the file browser's folder counts and author filter. */
export function cabinetCounts(world: World, buildingId: string): { type: Doc["type"]; authorId: string; n: number }[] {
  return world.db.prepare(`SELECT type, authorId, COUNT(*) AS n FROM docs WHERE buildingId = ? AND state != 'draft' AND type NOT IN (${BOARD_SQL}) GROUP BY type, authorId ORDER BY type, authorId`)
    .all(buildingId) as { type: Doc["type"]; authorId: string; n: number }[];
}

/** FTS5 query from free text: quoted terms OR'd together (ranked by bm25). */
export function ftsQuery(q: string): string | null {
  const terms = q.match(/[\p{L}\p{N}]+/gu);
  if (!terms?.length) return null;
  return terms.slice(0, 20).map((t) => `"${t}"`).join(" OR ");
}

export function searchDocs(world: World, holderId: string, input: { query: string; type?: Doc["type"]; state?: Doc["state"]; buildingId?: string; limit: number }): Doc[] {
  const where = ["(d.state != 'draft' OR d.authorId = ?)"];
  const params: unknown[] = [holderId];
  if (input.type) { where.push("d.type = ?"); params.push(input.type); }
  if (input.state) { where.push("d.state = ?"); params.push(input.state); }
  if (input.buildingId) { where.push("d.buildingId = ?"); params.push(input.buildingId); }
  const fts = ftsQuery(input.query);
  if (!fts) return world.docs.query(`SELECT d.* FROM docs d WHERE ${where.join(" AND ")} ORDER BY d.updatedAt DESC LIMIT ${input.limit}`, params);
  return world.docs.query(
    `SELECT d.* FROM docs_fts JOIN docs d ON d.rowid = docs_fts.rowid WHERE docs_fts MATCH ? AND ${where.join(" AND ")} ORDER BY bm25(docs_fts, 3.0, 1.0) LIMIT ${input.limit}`,
    [fts, ...params]);
}

export async function search(world: World, me: Agent, input: VerbIn<"search">) {
  const docs = searchDocs(world, world.holderOf(me).id, input);
  return { results: docs.map((d) => summarizeDoc(world, d)) };
}

export async function read(world: World, me: Agent, input: VerbIn<"read">) {
  const d = world.docs.get(input.id);
  if (!d || !canSeeDoc(world.holderOf(me), d)) throw new AppError("not_found", `No document ${input.id} (or it's someone's draft).`);
  const sources = d.provenance.sourceIds.map((id) => world.docs.get(id)).filter((s): s is Doc => !!s).map((s) => ({ id: s.id, title: s.title }));
  return { ...d, author: world.nameOf(d.authorId), sources };
}

export async function write(world: World, me: Agent, input: VerbIn<"write">) {
  if (WRITE_FORBIDDEN_TYPES.has(input.type)) throw badRequest(`Use ${input.type === "report" ? "submit_report" : input.type === "request" ? "request_human" : "the dedicated flow"} for ${input.type} docs.`);
  const holder = world.holderOf(me);
  const bid = me.buildingId ?? me.homeBuildingId;
  if (input.type === "notebook") return writeNotebook(world, me, holder, input.body);
  if (input.state === "building" && !world.permissions.can(me, "doc.write_building", bid)) throw forbidden("doc.write_building", "Not allowed to publish to this building's board (needs doc.write_building). Save it as a draft instead.");
  if (input.id) {
    const cur = world.docs.get(input.id);
    if (!cur) throw new AppError("not_found", `No document ${input.id}.`);
    if (cur.authorId !== holder.id) throw new AppError("forbidden", "You can only update documents you wrote.");
    if (cur.type === "notebook") throw badRequest("That's your notebook; update it with type \"notebook\".");
    const state = cur.state === "library" || cur.state === "trophy" ? cur.state : (input.type === "source" && input.state === "building" ? "library" : input.state);
    const doc = updateDoc(world, cur.id, {
      type: input.type, title: input.title, body: input.body, state,
      provenance: input.provenance ?? cur.provenance, tags: input.tags ?? cur.tags,
    });
    world.events.append({ type: "doc.updated", agentId: holder.kind === "agent" ? me.id : null, buildingId: doc.buildingId, text: `${me.name} updated "${doc.title}"`, payload: { docId: doc.id } });
    // only newly added mentions notify; a draft being published notifies everyone it mentions
    if (doc.state !== "draft") notifyMentions(world, me, `${doc.title}\n${doc.body}`, { where: docWhere(doc), docId: doc.id, buildingId: doc.buildingId }, cur.state !== "draft" ? `${cur.title}\n${cur.body}` : undefined);
    return { id: doc.id, state: doc.state };
  }
  // Source cards are references, not claims: once published they go straight to the library so every building can cite them.
  const state = input.type === "source" && input.state === "building" ? "library" : input.state;
  const doc = createDoc(world, {
    type: input.type, title: input.title, body: input.body, state, authorId: holder.id, authorKind: holder.kind,
    buildingId: bid, provenance: input.provenance, tags: input.tags,
  });
  if (doc.state !== "draft") notifyMentions(world, me, `${doc.title}\n${doc.body}`, { where: docWhere(doc), docId: doc.id, buildingId: doc.buildingId });
  return { id: doc.id, state: doc.state };
}

/**
 * The author's notebook: exactly one per author, always a private draft titled "<name>'s notebook", created on first
 * write and rewritten in place after that (upsert by author; \`id\`, \`title\` and \`state\` are ignored).
 */
function writeNotebook(world: World, me: Agent, holder: { id: string; kind: "agent" | "user" }, body: string) {
  const cur = notebookOf(world, holder.id);
  const title = `${me.name}'s notebook`;
  if (cur) {
    const doc = updateDoc(world, cur.id, { title, body, state: "draft" });
    world.events.append({ type: "doc.updated", agentId: holder.kind === "agent" ? me.id : null, buildingId: doc.buildingId, text: `${me.name} updated their notebook`, payload: { docId: doc.id, notebook: true } });
    return { id: doc.id, state: doc.state, note: "Notebook updated." };
  }
  const doc = createDoc(world, {
    type: "notebook", state: "draft", title, body, authorId: holder.id, authorKind: holder.kind, buildingId: me.homeBuildingId ?? me.buildingId,
  }, `${me.name} started a notebook`);
  return { id: doc.id, state: doc.state, note: "Notebook created." };
}

/** How many times in a row one piece of work may park itself (`submit_report` resumeWhen) before a human must decide. */
export const MAX_PARKS = 3;

export async function submit_report(world: World, me: Agent, input: VerbIn<"submit_report">) {
  if (me.kind === "human") throw badRequest("Humans don't submit reports.");
  const bid = homeOf(me);
  const building = bid ? world.buildings.get(bid) : undefined;
  const policy = building?.reviewPolicy ?? "human";
  const session = world.sessions.first("agentId = ? AND status = 'running'", [me.id], "ORDER BY startedAt DESC");
  const assignmentId = me.currentAssignmentId ?? session?.assignmentId ?? undefined;
  // P2: park instead of ending: the continuation waits for `resumeWhen` and then starts by itself (at most MAX_PARKS in a row)
  const resumeWhen = input.resumeWhen ? validateWait(world, input.resumeWhen) : null;
  const current = assignmentId ? world.assignments.get(assignmentId) : undefined;
  const parks = (current?.parked ?? 0) + 1;
  if (resumeWhen) {
    if (!current) throw badRequest("resumeWhen needs a current assignment to continue.");
    if (parks > MAX_PARKS) throw badRequest(`This work has already parked ${MAX_PARKS} times in a row; submit the report without resumeWhen and say what you're waiting on.`);
    if ("assignment" in resumeWhen && resumeWhen.assignment === current.id) throw badRequest("resumeWhen can't wait on your own current assignment.");
  }
  return world.transaction(() => {
    const doc = createDoc(world, {
      type: "report", state: "building", title: input.title, body: input.body, verdict: input.verdict, decision: "pending",
      authorId: me.id, authorKind: "agent", buildingId: bid, provenance: input.provenance,
      sessionId: session?.id, assignmentId: assignmentId ?? undefined, ...(resumeWhen ? { tags: ["parked"] } : {}),
    }, `${me.name} submitted a report: ${input.title}`);
    notifyMentions(world, me, `${doc.title}\n${doc.body}`, { where: docWhere(doc), docId: doc.id, buildingId: doc.buildingId });
    // a cancelled assignment (stopped/dismissed mid-session) stays cancelled; the report still lands
    const asg = assignmentId ? world.assignments.get(assignmentId) : undefined;
    if (asg && (asg.status === "pending" || asg.status === "active")) setAssignmentStatus(world, asg.id, "done", { reportId: doc.id });
    if (session) world.sessions.upsert({ ...session, reportId: doc.id });
    world.agents.patch(me.id, { currentAssignmentId: null });
    let parked: { assignmentId: string; waitingOn: string } | null = null;
    if (resumeWhen && current) {
      const what = describeWait(world, resumeWhen);
      const title = (input.next?.trim() || `Resume: ${current.title}`).slice(0, 160);
      const next = createAssignment(world, {
        agentId: me.id, buildingId: current.buildingId, title, waitFor: resumeWhen, parked: parks, front: true,
        createdBy: { kind: "system", id: "system" }, fromAssignmentId: current.id, fromReportId: doc.id,
        description: `You parked this work in your report "${doc.title}" (${doc.id}) until ${what}; that has happened, so it resumed by itself.${input.next ? `\n\nWhat you said you'd do: ${input.next.trim()}` : ""}\n\nThe original assignment (${current.id}): ${current.title}\n\n${current.description}`,
      });
      parked = { assignmentId: next.id, waitingOn: what };
    }
    // Hub semantics: the report goes to the building's in-tray and the agent goes idle. It only works again
    // when someone gives it an assignment (manager decision, reviewer `continue`, meeting decision, mention).
    let decision: Doc["decision"] = "pending";
    if (policy === "auto") {
      decision = "approve";
      applyDecision(world, doc.id, "approve", "Acknowledged automatically (review policy auto).", { kind: "system", id: "system" });
    }
    if (world.agents.get(me.id)?.status === "working") world.setStatus(me.id, "idle", `${me.name} filed a report and is idle`);
    if (parked) {
      return { id: doc.id, decision, reviewPolicy: policy, nextAssignmentId: parked.assignmentId,
        note: `Report submitted to your manager's in-tray; your work is parked and resumes by itself after ${parked.waitingOn} (a manager can Stop or Redirect it there). Your session ends now.` };
    }
    return { id: doc.id, decision, reviewPolicy: policy, nextAssignmentId: null, note: "Report submitted to your manager's in-tray. Your session ends now; you'll get a new assignment if there's more to do." };
  });
}

export async function review(world: World, me: Agent, input: VerbIn<"review">) {
  const doc = requirePendingReport(world, input.docId);
  if (!world.permissions.can(me, "building.review", doc.buildingId)) throw forbidden("building.review");
  const waitFor = input.waitFor ? validateWait(world, input.waitFor) : null;
  const res = world.transaction(() => applyDecision(world, doc.id, input.decision, input.note, world.holderOf(me), { waitFor }));
  return { docId: doc.id, decision: input.decision, assignmentId: res.assignment?.id ?? null };
}

export async function propose_trophy(world: World, me: Agent, input: VerbIn<"propose_trophy">) {
  const d = world.docs.require(input.docId, "doc");
  if (d.state !== "library") throw badRequest("Only library documents can be proposed for the trophy room.");
  const bid = me.buildingId ?? me.homeBuildingId;
  if (!world.permissions.can(me, "doc.propose_trophy", bid) && !world.permissions.can(me, "doc.propose_trophy", d.buildingId)) throw forbidden("doc.propose_trophy");
  const doc = updateDoc(world, d.id, { trophyProposedBy: world.holderOf(me).id, trophyWhy: input.why });
  world.events.append({ type: "doc.updated", agentId: me.kind === "human" ? null : me.id, buildingId: doc.buildingId, text: `${me.name} proposed "${doc.title}" for the trophy room`, payload: { docId: doc.id, trophyProposed: true, why: input.why } });
  return { docId: doc.id, proposed: true };
}

export async function request_human(world: World, me: Agent, input: VerbIn<"request_human">) {
  const bid = homeOf(me);
  if (!world.permissions.can(me, "doc.request_human", bid)) throw forbidden("doc.request_human");
  const holder = world.holderOf(me);
  const doc = createDoc(world, {
    type: "request", state: "building", title: input.title, body: input.body, location: input.location,
    requestStatus: "proposed", tags: [input.kind], authorId: holder.id, authorKind: holder.kind, buildingId: bid,
  }, `${me.name} asked for human help: ${input.title}`);
  return { id: doc.id, requestStatus: doc.requestStatus, note: "A moderator must approve it before humans see it in the outbox." };
}

export async function assign(world: World, me: Agent, input: VerbIn<"assign">) {
  const target = world.agents.require(input.agentId, "agent");
  const bid = homeOf(target);
  if (!world.permissions.can(me, "building.assign", bid)) throw forbidden("building.assign");
  const waitFor = input.waitFor ? validateWait(world, input.waitFor) : null;
  const a = createAssignment(world, { agentId: target.id, title: input.title, description: input.description, createdBy: world.holderOf(me), waitFor });
  sendMessage(world, { kind: "system", fromId: me.id, fromKind: "system", toId: target.id, body: `New assignment from ${me.name}: ${input.title}${waitFor ? ` (starts after ${describeWait(world, waitFor)})` : ""}` });
  return { assignmentId: a.id, ...(waitFor ? { waitingOn: describeWait(world, waitFor) } : {}) };
}

export async function promote(world: World, me: Agent, input: VerbIn<"promote">) {
  const d = world.docs.require(input.docId, "doc");
  if (!world.permissions.can(me, "building.promote", d.buildingId)) throw forbidden("building.promote");
  if (d.state === input.state) return { docId: d.id, state: d.state };
  const doc = updateDoc(world, d.id, { state: input.state });
  world.events.append({ type: "doc.state", agentId: me.kind === "human" ? null : me.id, buildingId: doc.buildingId, text: `"${doc.title}" moved to the ${input.state === "library" ? "library" : "building board"}`, payload: { docId: doc.id, state: input.state, from: d.state, by: world.holderOf(me).id } });
  return { docId: doc.id, state: doc.state };
}
