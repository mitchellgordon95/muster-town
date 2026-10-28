import {
  BOARD_TYPES, parseRollup, ROLLUP_MAX_NEEDS, ROLLUP_NEEDS_RULE, rollupNeedsCount, rollupNeedsIds, rollupWarnings, withNeedsLine, type Agent, type Doc, type LaneFields,
} from "@muster-town/schema";
import {
  applyDecision, canSeeDoc, createAssignment, createDoc, grantsAwaitingDecision, homeOf, isTownHallItem, managerAgentOf, requirePendingReport, sendMessage,
  setAssignmentStatus, summarizeDoc, updateDoc,
} from "../domain.ts";
import { AppError, badRequest, forbidden } from "../errors.ts";
import { isCheckpointAssignment } from "../lanes.ts";
import { docWhere, notifyMentions } from "../mentions.ts";
import { appendAgentLog, canWriteTopic, MAX_ATTACHED_PAGES, ownerOf, revisionsOf, writeTopicPage, writeWikiPage } from "../memory.ts";
import { checkForkModel } from "../forks.ts";
import { actOrigin } from "../origin.ts";
import { ftsQuery } from "../text.ts";
import { nowIso } from "../util.ts";
import { describeWait, validateWait } from "../waits.ts";
import type { World } from "../world.ts";
import { TOWN_HALL_ID } from "../world/layout.ts";
import type { VerbIn } from "./types.ts";

const WRITE_FORBIDDEN_TYPES = new Set<Doc["type"]>(["report", "request", "human-report", "meeting-notes"]);

export async function board(world: World, me: Agent, input: VerbIn<"board">) {
  const bid = input.buildingId ?? me.buildingId ?? me.homeBuildingId;
  if (!bid) throw badRequest("You're not in a building; pass buildingId.");
  const b = world.buildings.require(bid, "building");
  const docs = boardWithTownDocs(world, bid, input.limit);
  return { building: { id: b.id, name: b.name, goal: b.goal }, docs: docs.map((d) => ({ ...summarizeDoc(world, d), ...(d.townWide ? { townWide: true, from: "Town Hall" } : {}) })) };
}

const BOARD_SQL = BOARD_TYPES.map((t) => `'${t}'`).join(", ");

/** The building board: building-wide FYIs published to the building. Everything else is filed in the cabinet. */
export function boardDocs(world: World, buildingId: string, limit: number): Doc[] {
  return world.docs.where(`buildingId = ? AND state = 'building' AND type IN (${BOARD_SQL})`, [buildingId], `ORDER BY updatedAt DESC, rowid DESC LIMIT ${limit}`);
}

/** The Town Hall board's FYIs: town-wide rules that show on every building's board. */
export function townBoardDocs(world: World, limit: number): Doc[] {
  return boardDocs(world, TOWN_HALL_ID, limit);
}

/**
 * A building's board as `board` and GET /api/buildings/:id/board show it: the Town Hall's FYIs first, marked
 * `townWide`, then the building's own (newest first, `limit` each). The Town Hall's own board is just its FYIs.
 */
export function boardWithTownDocs(world: World, buildingId: string, limit: number): (Doc & { townWide?: true })[] {
  const own = boardDocs(world, buildingId, limit);
  if (buildingId === TOWN_HALL_ID) return own;
  return [...townBoardDocs(world, limit).map((d) => ({ ...d, townWide: true as const })), ...own];
}

/** Who may post an FYI to the Town Hall board: town admins, humans or agents with building.manage on any building, and a live fork of a manager who may. */
export function canPostTownBoard(world: World, me: Agent): boolean {
  if (world.permissions.isAdmin(me)) return true;
  const manager = world.permissions.managerOfFork(me);
  if (manager) return canPostTownBoard(world, manager);
  return world.buildings.all().some((b) => world.permissions.can(me, "building.manage", b.id));
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

export { ftsQuery };

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
  if (input.file !== undefined && d.type !== "skill") throw badRequest("`file` is only for skills (type \"skill\").");
  if (d.type === "skill" && input.file !== undefined) {
    const content = world.skills.file(d.id, input.file);
    world.skills.used(me, d, input.file);
    // the file comes back in the doc's shape: body = the file's content, file = its path
    return { ...d, author: world.nameOf(d.authorId), sources: [] as { id: string; title: string }[], file: input.file, body: content };
  }
  const sources = d.provenance.sourceIds.map((id) => world.docs.get(id)).filter((s): s is Doc => !!s).map((s) => ({ id: s.id, title: s.title }));
  if (d.type === "skill") {
    world.skills.used(me, d);
    const files = world.skills.files(d.id);
    return { ...d, author: world.nameOf(d.authorId), sources, files,
      ...(files.length ? { filesNote: "Read one with `read` {id, file}. On a desk you can save them under ~/skills/<name>/ and run the scripts." } : {}) };
  }
  const revisions = d.topicOf ? revisionsOf(world, d.id).map((r) => ({ ...r, author: world.nameOf(r.authorId), replacedByName: world.nameOf(r.replacedBy) })) : undefined;
  return { ...d, author: world.nameOf(d.authorId), sources, ...(revisions ? { revisions } : {}) };
}

/** `skills`: what I can use right now: my pinned skills first, then my building's and the library's (and my drafts). */
export async function skills(world: World, me: Agent, input: VerbIn<"skills">) {
  const pinned = world.skills.forAgent(me.id);
  const pinnedIds = new Set(pinned.map((s) => s.doc.id));
  const words = (input.query?.toLowerCase().match(/[\p{L}\p{N}-]+/gu) ?? []);
  const matches = (text: string) => words.every((w) => text.toLowerCase().includes(w));
  const line = (v: ReturnType<typeof world.skills.view>) => ({
    id: v.id, name: v.name, description: v.description, state: v.state, author: v.author, files: v.files.map((f) => f.path), uses30d: v.uses30d,
  });
  const pinnedOut = pinned.filter((s) => matches(`${s.md.name} ${s.md.description}`))
    .map((s) => ({ ...line(world.skills.view(s.doc)), pinned: { scope: s.scope, mode: s.mode } }));
  const others = world.skills.visibleTo(me, input.query).filter((d) => !pinnedIds.has(d.id)).slice(0, input.limit).map((d) => line(world.skills.view(d)));
  return {
    pinned: pinnedOut, available: others,
    note: "`read` a skill (its id) to load it; `read` with `file` opens a bundled file. Write your own with `write` type \"skill\" (a SKILL.md body, optional `files`); `pin` puts one into your sessions.",
  };
}

/** `pin`: pin a skill into sessions (scope agent / building / town; mode listed / always), or unpin it (remove). */
export async function pin(world: World, me: Agent, input: VerbIn<"pin">) {
  if (input.remove) return world.skills.unpin(me, input.skillId, input);
  return { pin: world.skills.pin(me, input.skillId, input) };
}

export async function write(world: World, me: Agent, input: VerbIn<"write">) {
  if (WRITE_FORBIDDEN_TYPES.has(input.type)) throw badRequest(`Use ${input.type === "report" ? "submit_report" : input.type === "request" ? "request_human" : "the dedicated flow"} for ${input.type} docs.`);
  const holder = world.holderOf(me);
  if (input.buildingId && input.type !== "fyi") throw badRequest("`buildingId` is only for FYIs (type \"fyi\"): it picks the board to post to, e.g. \"town-hall\" for a town-wide FYI.");
  if (input.buildingId) world.buildings.require(input.buildingId, "building");
  const bid = input.buildingId ?? me.buildingId ?? me.homeBuildingId;
  if (input.type === "notebook") throw badRequest('The notebook became a wiki: write one private page per topic with type "wiki" (title = the topic), and durable events as one-line entries with type "log".');
  if (input.topicOf && input.type !== "wiki") throw badRequest("`topicOf` is only for wiki pages (type \"wiki\").");
  if (input.type === "wiki") {
    if (!input.title.trim()) throw badRequest('A wiki page needs a title: the topic it covers (e.g. "The Bank").');
    const cur = input.id ? world.docs.get(input.id) : undefined;
    const topicOf = input.topicOf ?? (cur?.type === "wiki" ? cur.topicOf : undefined);
    if (topicOf) {
      if (topicOf !== homeOf(me)) throw badRequest(`\`topicOf\` is your building id (${homeOf(me) ?? "you have none"}): topic pages belong to the building you work in.`);
      if (!canWriteTopic(world, me, topicOf)) throw forbidden("building.manage", "Only the building's manager and its forks write its topic pages. Write a private page (leave topicOf out), or put it in your report.");
      const { doc, created } = writeTopicPage(world, me, topicOf, input.title, input.body, input.id);
      return { id: doc.id, state: doc.state, topicOf, note: created ? `Topic page "${doc.title}" created in ${world.buildings.get(topicOf)?.name ?? topicOf} (everyone there reads it; its manager and forks rewrite it).` : `Topic page "${doc.title}" rewritten; the old version is kept as a revision.` };
    }
    if (me.forkOf) throw new AppError("forbidden", "forks write topic pages (topicOf) or skills");
    const { doc, created } = writeWikiPage(world, ownerOf(me, holder), input.title, input.body, input.id);
    return { id: doc.id, state: doc.state, note: created ? `Wiki page "${doc.title}" created (private; shown to you at the start of every session).` : `Wiki page "${doc.title}" rewritten.` };
  }
  if (input.type === "log") {
    const doc = appendAgentLog(world, me, input.body);
    return { id: doc.id, state: doc.state, note: me.forkOf ? `Logged in ${world.nameOf(me.forkOf)}'s log.` : "Logged." };
  }
  if (input.files && input.type !== "skill") throw badRequest("`files` are only for skills (type \"skill\").");
  // a skill's title is its SKILL.md name (validated, unique town-wide)
  const title = input.type === "skill" ? world.skills.validate(input.body, holder.id, input.id).name : input.title;
  if (input.state === "building" && input.type === "fyi" && bid === TOWN_HALL_ID) {
    if (!canPostTownBoard(world, me)) throw forbidden("building.manage", "Only town admins, managers (building.manage on a building) and their forks post to the Town Hall board. Save it as a draft, or ask your manager.");
  } else if (input.state === "building" && !world.permissions.can(me, "doc.write_building", bid)) throw forbidden("doc.write_building", "Not allowed to publish to this building's board (needs doc.write_building). Save it as a draft instead.");
  if (input.id) {
    const cur = world.docs.get(input.id);
    if (!cur) throw new AppError("not_found", `No document ${input.id}.`);
    if (cur.authorId !== holder.id) throw new AppError("forbidden", "You can only update documents you wrote.");
    if (cur.type === "wiki" || cur.type === "log" || cur.type === "notebook") throw badRequest(cur.type === "log" ? "That's your log; append to it with type \"log\"." : "That's a page of your wiki; rewrite it with type \"wiki\".");
    if ((cur.type === "skill") !== (input.type === "skill")) throw badRequest(cur.type === "skill" ? "That's a skill; update it with type \"skill\"." : "A doc can't become a skill; write a new one with type \"skill\".");
    const state = cur.state === "library" || cur.state === "trophy" ? cur.state : (input.type === "source" && input.state === "building" ? "library" : input.state);
    const doc = world.transaction(() => {
      if (input.files) world.skills.setFiles(cur.id, input.files);
      return updateDoc(world, cur.id, {
        type: input.type, title, body: input.body, state,
        provenance: input.provenance ?? cur.provenance, tags: input.tags ?? cur.tags,
      });
    });
    world.events.append({ type: "doc.updated", agentId: holder.kind === "agent" ? me.id : null, buildingId: doc.buildingId, text: `${me.name} updated "${doc.title}"`, payload: { docId: doc.id } });
    // only newly added mentions notify; a draft being published notifies everyone it mentions
    if (doc.state !== "draft") notifyMentions(world, me, `${doc.title}\n${doc.body}`, { where: docWhere(doc), docId: doc.id, buildingId: doc.buildingId }, cur.state !== "draft" ? `${cur.title}\n${cur.body}` : undefined);
    return { id: doc.id, state: doc.state, ...(doc.type === "skill" ? { files: world.skills.files(doc.id).map((f) => f.path) } : {}) };
  }
  // Source cards are references, not claims: once published they go straight to the library so every building can cite them.
  const state = input.type === "source" && input.state === "building" ? "library" : input.state;
  const doc = world.transaction(() => {
    const d = createDoc(world, {
      type: input.type, title, body: input.body, state, authorId: holder.id, authorKind: holder.kind,
      buildingId: bid, provenance: input.provenance, tags: input.tags,
    });
    if (input.files) world.skills.setFiles(d.id, input.files);
    return d;
  });
  if (doc.state !== "draft") notifyMentions(world, me, `${doc.title}\n${doc.body}`, { where: docWhere(doc), docId: doc.id, buildingId: doc.buildingId });
  if (doc.type === "skill") {
    return { id: doc.id, state: doc.state, name: doc.title, files: world.skills.files(doc.id).map((f) => f.path),
      note: doc.state === "draft" ? "Skill saved as a draft (only you see it). `pin` it into your own sessions, or write it again with state \"building\" to share it in your building." : "Skill published in your building. A manager can `promote` it to the library (town-wide) and `pin` it." };
  }
  return { id: doc.id, state: doc.state };
}

type KrWrite = ReturnType<World["grantDesk"]["writtenSince"]>[number];

/** The rollup section listing them (appended by `submit_report`), each with its id, so Mitchell can keep or cut it. */
export function krWritesSection(writes: KrWrite[]): string {
  const rows = writes.map((w) => `- ${w.action} ${w.keyResultId}: "${w.text}" (how to check: ${w.howToCheck || "?"}${w.sourceDocIds.length ? `; from ${w.sourceDocIds.join(", ")}` : ""})`);
  return `## Key results I wrote (keep or cut: Building → Settings → Key results)\n${rows.join("\n")}`;
}

/** How many times in a row one piece of work may park itself (`submit_report` resumeWhen) before a human must decide. */
export const MAX_PARKS = 3;

export async function submit_report(world: World, me: Agent, input: VerbIn<"submit_report">) {
  if (me.kind === "human") throw badRequest("Humans don't submit reports.");
  // a visitor with no home building (bench, plaza, or standing in someone else's lab) reports to the Town Hall in-tray
  // as a visitor report, which the humans work (dc_04i3sll7q5); a homed visitor reports to its home building like a resident
  const unhomedVisitor = me.kind === "visitor" && !me.homeBuildingId;
  const bid = unhomedVisitor ? world.buildings.first("kind = 'town-hall'")?.id ?? null : homeOf(me);
  const building = bid ? world.buildings.get(bid) : undefined;
  // Town hall 2026-10-24, decision 1: a resident's report goes to the building in-tray, worked by the manager agent
  // when there is one (else by humans). Town hall 2026-10-25, decision 6: only a rollup (a checkpoint report is one)
  // goes to the Town Hall in-tray; the manager's own work report lands in its building's in-tray like a resident's,
  // and the manager decides it in its next team-lead session.
  const isManager = !!building && building.kind !== "town-hall" && building.managerAgentId === me.id;
  const townHall = isManager && !!input.rollup;
  const manager = townHall ? undefined : managerAgentOf(world, building);
  const sourceIds = input.provenance?.sourceIds ?? [];
  const session = world.sessions.first("agentId = ? AND status = 'running'", [me.id], "ORDER BY startedAt DESC");
  const assignmentId = me.currentAssignmentId ?? session?.assignmentId ?? undefined;
  const current = assignmentId ? world.assignments.get(assignmentId) : undefined;
  // goal-directed budgets: the rollup of a checkpoint assignment is the grant's checkpoint report (a grant may have no reports yet)
  const checkpointGrantId = input.rollup && current && isCheckpointAssignment(current) ? current.grantId : null;
  // close_grant without a reportId: this session's rollup is the close report of the grants the manager closed as done in it
  const closedGrants = input.rollup && isManager && session && !checkpointGrantId
    ? world.grants.where("buildingId = ? AND status = 'closed' AND outcome = 'done' AND checkpointDocId IS NULL AND closedAt >= ?", [bid!, session.startedAt])
      .filter((g) => g.history.at(-1)?.byId === me.id)
    : [];
  // a manager's rollup lists every key result it wrote or edited since its last rollup, so a human can cut it (1:1 mt_ayi4y9ybyj)
  const krWrites = input.rollup && isManager ? world.grantDesk.writtenSinceRollup(me.id, bid!) : [];
  if (unhomedVisitor && !bid) throw badRequest("The town has no Town Hall to file a visitor report in.");
  if (input.rollup) {
    if (!isManager) throw badRequest("Only a building's manager agent submits rollups.");
    if (!sourceIds.length && !checkpointGrantId && !closedGrants.length && !krWrites.length) throw badRequest("A rollup lists the reports it covers in provenance.sourceIds.");
    for (const id of sourceIds) {
      const d = world.docs.get(id);
      if (!d || d.type !== "report" || d.buildingId !== bid) throw badRequest(`Rollup source ${id} is not a report of your building.`);
    }
  }
  // the rollup format (1:1 mt_vcn0e66r1t): the four headings are required; a Shipped item without its labels is only warned
  const format = input.rollup ? parseRollup(input.body) : null;
  if (format?.missingSections.length) throw badRequest(`A rollup has four sections: ## Shipped, ## Decided, ## Key results, ## Needs from Mitchell. Missing: ${format.missingSections.map((s) => `## ${s}`).join(", ")}.`);
  const formatWarnings = format ? rollupWarnings(format) : [];
  // Needs from Mitchell carries only what has no other channel (1:1 mt_uf1bwd3exq): naming an item that already waits
  // for a human in the Town Hall in-tray or the outbox is refused; the town lists those itself (rollupWaitingLine)
  if (format) {
    // a checkpoint or close rollup asks about its own grant: that is what the rollup is for
    const own = new Set([checkpointGrantId, ...closedGrants.map((g) => g.id)]);
    const dup = rollupNeedsIds(input.body).filter((id) => !own.has(id)).flatMap((id) => { const why = waitingForHuman(world, id); return why ? [`${id} (${why})`] : []; });
    if (dup.length) throw badRequest(`Needs from Mitchell names what already waits for him elsewhere: ${dup.join(", ")}. Take it out and resubmit; the town appends an "Already waiting in your in-tray" line that lists it. The rule: ${ROLLUP_NEEDS_RULE}`);
    const needs = rollupNeedsCount(input.body);
    if (needs > ROLLUP_MAX_NEEDS) formatWarnings.push(`${needs} Needs items; keep it to ${ROLLUP_MAX_NEEDS}`);
  }
  const formatNote = formatWarnings.length ? ` Format warnings (filed anyway; unlabelled Shipped items show as plain text instead of cards): ${formatWarnings.join("; ")}. Next rollup: each Shipped item gets **What it is:**, **What you'd see:** (one cropped picture) and **Your call:**; Needs keeps to ${ROLLUP_MAX_NEEDS} items.` : "";
  // P2: park instead of ending: the continuation waits for `resumeWhen` and then starts by itself (at most MAX_PARKS in a row)
  const resumeWhen = input.resumeWhen ? validateWait(world, input.resumeWhen) : null;
  const parks = (current?.parked ?? 0) + 1;
  if (resumeWhen) {
    if (!current) throw badRequest("resumeWhen needs a current assignment to continue.");
    if (parks > MAX_PARKS) throw badRequest(`This work has already parked ${MAX_PARKS} times in a row; submit the report without resumeWhen and say what you're waiting on.`);
    if ("assignment" in resumeWhen && resumeWhen.assignment === current.id) throw badRequest("resumeWhen can't wait on your own current assignment.");
  }
  const owner = unhomedVisitor && me.ownerUserId ? world.users.get(me.ownerUserId)?.name ?? null : null;
  const filed = format ? withNeedsLine(input.body, rollupWaitingLine(world, bid!)) : input.body;
  const body = krWrites.length ? `${filed.trimEnd()}\n\n${krWritesSection(krWrites)}`
    : unhomedVisitor ? `${input.body.trimEnd()}\n\n_Visitor report from ${me.name}${owner ? `, ${owner}'s agent` : ""}; it has no home building._` : filed;
  return world.transaction(() => {
    const doc = createDoc(world, {
      type: "report", state: "building", title: input.title, body, verdict: input.verdict, decision: "pending",
      authorId: me.id, authorKind: "agent", buildingId: bid, provenance: input.provenance,
      sessionId: session?.id, assignmentId: assignmentId ?? undefined,
      tags: [...(input.rollup ? ["rollup"] : []), ...(unhomedVisitor ? ["visitor"] : []), ...(checkpointGrantId ? ["checkpoint"] : []), ...(closedGrants.length ? ["grant-close"] : []), ...(resumeWhen ? ["parked"] : [])],
    }, `${me.name} submitted a ${input.rollup ? "rollup" : "report"}: ${input.title}`);
    if (checkpointGrantId) {
      const g = world.grants.get(checkpointGrantId);
      if (g) world.grants.upsert({ ...g, checkpointDocId: doc.id, updatedAt: nowIso() });
    }
    for (const g of closedGrants) world.grants.upsert({ ...g, checkpointDocId: doc.id, updatedAt: nowIso() });
    // decision 1d: humans aren't notified of reports a manager agent will consume; only Town Hall items reach them
    notifyMentions(world, me, `${doc.title}\n${doc.body}`, { where: docWhere(doc), docId: doc.id, buildingId: doc.buildingId, agentsOnly: !!manager });
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
    // when someone gives it an assignment (a decision on the report, meeting decision, mention).
    const decision: Doc["decision"] = "pending";
    if (world.agents.get(me.id)?.status === "working") world.setStatus(me.id, "idle", `${me.name} filed a report and is idle`);
    const intray = townHall ? "town-hall" : bid;
    const where = townHall ? "the Town Hall in-tray (the humans decide on it)"
      : unhomedVisitor ? "the Town Hall in-tray as a visitor report (a human works it)"
      : manager?.id === me.id ? `the ${building!.name} in-tray, which you work as its manager: decide it in your next team-lead session and fold it into your rollup`
      : manager ? `the ${building!.name} in-tray, which ${manager.name}, your manager, works` : "your building's in-tray (a human works it)";
    const workedBy = manager ? "manager" : "human";
    if (parked) {
      return { id: doc.id, decision, intray, workedBy, nextAssignmentId: parked.assignmentId, ...(formatWarnings.length ? { warnings: formatWarnings } : {}),
        note: `Report submitted to ${where}.${formatNote} Your work is parked and resumes by itself after ${parked.waitingOn} (whoever works the in-tray can Stop or Redirect it there). Your session ends now.` };
    }
    return { id: doc.id, decision, intray, workedBy, nextAssignmentId: null, ...(formatWarnings.length ? { warnings: formatWarnings } : {}), note: `Report submitted to ${where}.${formatNote} Your session ends now; you'll get a new assignment if there's more to do.` };
  });
}

/** Why `id` already waits for a human outside a rollup's Needs (a grant in the Town Hall in-tray, an open outbox request, a pending rollup), or null. */
function waitingForHuman(world: World, id: string): string | null {
  if (id.startsWith("gr_")) {
    const g = grantsAwaitingDecision(world).find((v) => v.id === id);
    return !g || g.status === "countered" ? null : g.status === "proposed" ? "a grant proposal in the Town Hall in-tray" : "a grant decision in the Town Hall in-tray";
  }
  const d = world.docs.get(id);
  if (d?.type === "request" && d.requestStatus === "open") return "an open outbox request";
  if (d?.type === "report" && d.decision === "pending" && isTownHallItem(world, d)) return "a report in the Town Hall in-tray";
  return null;
}

/**
 * The generated line under a rollup's Needs (1:1 mt_uf1bwd3exq): what of this building already waits for the humans,
 * computed at submit time. Not written by the manager.
 */
function rollupWaitingLine(world: World, buildingId: string): string {
  const proposals = world.grants.where("buildingId = ? AND status = 'proposed'", [buildingId], "ORDER BY createdAt, rowid").map((g) => g.id);
  const requests = world.docs.where("type = 'request' AND requestStatus = 'open' AND buildingId = ?", [buildingId], "ORDER BY createdAt, rowid").map((d) => d.id);
  const rollups = world.docs.where("type = 'report' AND decision = 'pending' AND buildingId = ? AND tags LIKE '%\"rollup\"%'", [buildingId], "ORDER BY createdAt, rowid").map((d) => d.id);
  if (!proposals.length && !requests.length && !rollups.length) return "_Nothing else waiting in your in-tray._";
  const part = (ids: string[], one: string) => `${ids.length} ${one}${ids.length === 1 ? "" : "s"}${ids.length ? ` (${ids.join(", ")})` : ""}`;
  return `_Already waiting in your in-tray: ${part(proposals, "proposal")}, ${part(requests, "request")}, ${part(rollups, "rollup")}._`;
}

/** The lane fields of a verb input (`assign`, `review`), or undefined when none is given (a continuation inherits). */
const laneOf = (i: LaneFields): LaneFields | undefined =>
  i.lane || i.grantId || i.keyResultId || i.gap || i.sourceId ? { lane: i.lane, grantId: i.grantId, keyResultId: i.keyResultId, gap: i.gap, sourceId: i.sourceId } : undefined;

export async function review(world: World, me: Agent, input: VerbIn<"review">) {
  const doc = requirePendingReport(world, input.docId);
  if (!world.permissions.can(me, "building.review", doc.buildingId)) throw forbidden("building.review");
  // an agent decides its own report only as the manager deciding its own work report (town hall 2026-10-25, decision 6);
  // a rollup waits for the humans
  if (me.kind !== "human" && doc.authorId === me.id && (isTownHallItem(world, doc) || managerAgentOf(world, world.buildings.get(doc.buildingId ?? ""))?.id !== me.id)) {
    throw badRequest(isTownHallItem(world, doc) ? "You can't decide on your own rollup or visitor report; it waits for the humans in the Town Hall in-tray." : "You can't decide on your own report.");
  }
  const waitFor = input.waitFor ? validateWait(world, input.waitFor) : null;
  const res = world.transaction(() => applyDecision(world, doc.id, input.decision, input.note, world.holderOf(me), { waitFor, assigneeId: input.assigneeId ?? null, lane: laneOf(input) }));
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
    requestStatus: "open", tags: [input.kind], authorId: holder.id, authorKind: holder.kind, buildingId: bid,
  }, `${me.name} asked for human help: ${input.title}`);
  return { id: doc.id, requestStatus: doc.requestStatus, note: "It is in the town outbox now; a human decides whether to do it and reports back." };
}

export async function assign(world: World, me: Agent, input: VerbIn<"assign">) {
  // manager forks: no agentId = the building queue (forks on); the manager holds it until a fork takes it
  const building = input.agentId ? null : world.buildings.get(homeOf(me) ?? "");
  if (!input.agentId) {
    if (!building) throw badRequest("Name the agentId to assign.");
    if (!building.forks) throw badRequest(`Name the agentId to assign: ${building.name} doesn't queue work to the building (forks are off).`);
    if (!managerAgentOf(world, building)) throw badRequest(`${building.name} has no manager agent to fork; name the agentId.`);
  } else if (input.model) throw badRequest("`model` is for building-queue work (leave agentId out); a named agent runs on its own model.");
  const target = building ? managerAgentOf(world, building)! : world.agents.require(input.agentId!, "agent");
  const bid = homeOf(target);
  if (!world.permissions.can(me, "building.assign", bid)) throw forbidden("building.assign");
  const waitFor = input.waitFor ? validateWait(world, input.waitFor) : null;
  const model = building ? checkForkModel(building, input.model) : null;
  const pages = input.pages?.length ? attachablePages(world, bid, input.pages) : undefined;
  // wakes step 1: an agent's assign carries its session's human origin (hops + 1); a human's is stamped by createAssignment
  const a = createAssignment(world, { agentId: target.id, title: input.title, description: input.description, createdBy: world.holderOf(me), waitFor,
    lane: laneOf(input), ...(me.kind === "human" ? {} : { origin: actOrigin(world, me, null) }), ...(building ? { queue: "building" as const, model } : {}) });
  if (pages) world.assignments.patch(a.id, { pages });
  if (!building) sendMessage(world, { kind: "system", fromId: me.id, fromKind: "system", toId: target.id, body: `New assignment from ${me.name}: ${input.title}${waitFor ? ` (starts after ${describeWait(world, waitFor)})` : ""}` });
  return { assignmentId: a.id, lane: a.lane, ...(pages ? { pages } : {}), ...(building ? { queue: "building" as const, ...(model ? { model } : {}) } : {}), ...(a.heldReason ? { held: a.heldReason } : {}), ...(waitFor ? { waitingOn: describeWait(world, waitFor) } : {}) };
}

/** `assign … pages`: distinct topic pages of the building, at most MAX_ATTACHED_PAGES. */
function attachablePages(world: World, bid: string | null, ids: string[]): string[] {
  const uniq = [...new Set(ids)];
  if (uniq.length > MAX_ATTACHED_PAGES) throw badRequest(`Attach at most ${MAX_ATTACHED_PAGES} topic pages.`);
  for (const id of uniq) {
    const d = world.docs.get(id);
    if (!d || d.type !== "wiki" || !d.topicOf || d.topicOf !== bid) throw badRequest(`${id} isn't a topic page of this building (\`write\` type "wiki" with topicOf).`);
  }
  return uniq;
}

/**
 * The manager's queued assignment in its own building, for `reassign` / `cancel`: refused when it has started (or
 * ended) or belongs to another building.
 */
function queuedInMyBuilding(world: World, me: Agent, assignmentId: string) {
  const a = world.assignments.require(assignmentId, "assignment");
  const bid = homeOf(me);
  const owner = world.agents.require(a.agentId, "agent");
  if (!bid || !world.permissions.can(me, "building.assign", bid)) throw forbidden("building.assign");
  if (a.buildingId !== bid || homeOf(owner) !== bid) throw new AppError("forbidden", `"${a.title}" belongs to another building (${world.buildings.get(a.buildingId)?.name ?? a.buildingId}); you can move or cancel only your own building's queued assignments.`);
  if (a.status !== "pending") throw new AppError("conflict", a.status === "active" ? `"${a.title}" has started (${owner.name} is on it); only queued assignments can be moved or cancelled.` : `Assignment "${a.title}" is already ${a.status}.`);
  return { a, owner, bid };
}

/** `reassign` (the manager): move a queued assignment to another resident of the building (POST /assignments/:id/delegate). */
export async function reassign(world: World, me: Agent, input: VerbIn<"reassign">) {
  const { a, owner, bid } = queuedInMyBuilding(world, me, input.assignmentId);
  const to = world.agents.require(input.agentId, "agent");
  if (homeOf(to) !== bid) throw badRequest(`${to.name} isn't a resident of ${world.buildings.get(bid)?.name ?? bid}; reassign only within your building.`);
  const { assignment } = world.ops.delegateAssignment(me, a.id, to.id);
  const waitingOn = assignment.waitFor ? describeWait(world, assignment.waitFor) : null;
  sendMessage(world, { kind: "system", fromId: me.id, fromKind: "system", toId: to.id, body: `New assignment from ${me.name} (was ${owner.name}'s): ${a.title}${waitingOn ? ` (starts after ${waitingOn})` : ""}` });
  return { assignmentId: assignment.id, from: { assignmentId: a.id, agentId: owner.id, status: "cancelled" }, agentId: to.id, lane: assignment.lane, grantId: assignment.grantId, keyResultId: assignment.keyResultId, ...(waitingOn ? { waitingOn } : {}) };
}

/** `cancel` (the manager): cancel a queued assignment in the building (POST /assignments/:id/cancel). */
export async function cancel(world: World, me: Agent, input: VerbIn<"cancel">) {
  const { a } = queuedInMyBuilding(world, me, input.assignmentId);
  const c = world.ops.cancelAssignment(me, a.id);
  return { assignmentId: c.id, status: c.status };
}

export async function promote(world: World, me: Agent, input: VerbIn<"promote">) {
  const d = world.docs.require(input.docId, "doc");
  if (!world.permissions.can(me, "building.promote", d.buildingId)) throw forbidden("building.promote");
  if (d.state === input.state) return { docId: d.id, state: d.state };
  const doc = updateDoc(world, d.id, { state: input.state });
  world.events.append({ type: "doc.state", agentId: me.kind === "human" ? null : me.id, buildingId: doc.buildingId, text: `"${doc.title}" moved to the ${input.state === "library" ? "library" : "building board"}`, payload: { docId: doc.id, state: input.state, from: d.state, by: world.holderOf(me).id } });
  return { docId: doc.id, state: doc.state };
}
