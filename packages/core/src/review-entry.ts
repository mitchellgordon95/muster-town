/**
 * `review` on an entry that has no doc (plan dc_uwx045472m step 5): what waits for a building's manager on a job's
 * thread without a report behind it. A session that died; a human's counter, reject, cut or missed key result; a
 * human's words (a relayed tell, an @mention, an outbox answer).
 *
 * - approve: taken in, nothing follows (a dead session's work is dropped).
 * - continue: a dead session's work goes back on the queue as it was (same lane, same plan step), with what the session left.
 * - redirect: the note becomes a new assignment on the same job's lane (a dead session's) or the building queue.
 * - stop: for a dead session, as approve; nothing else has an agent to stop.
 * Each writes one answer entry on the thread. Passing up is `passUpWithAsk`.
 */
import type { Agent, Ask, Assignment, LaneFields, ReviewDecision, AskCardInput, WaitFor } from "@muster-town/schema";
import { askStructure, askWarnings } from "@muster-town/schema";
import { dictionaryPairs } from "./dictionary.ts";
import { checkAskCards, createAsk, refuseMissingStructure } from "./asks.ts";
import { createAssignment, managerAgentOf } from "./domain.ts";
import type { Holder } from "./permissions.ts";
import { AppError, badRequest } from "./errors.ts";
import { answerEntry, appendEntry, entryOf, isAnswered, jobThread, setEntryLevel, type Entry } from "./jobs.ts";
import { DIRECTED, type Lane } from "./lanes.ts";
import type { World } from "./world.ts";

const firstLine = (s: string, n = 120) => { const f = s.trim().split("\n")[0]!.trim(); return f.length > n ? `${f.slice(0, n - 1)}…` : f; };

/** The entry `id` names, when it still waits for the manager; refused with the reason otherwise. */
export function requireOpenEntry(world: World, id: string): Entry & { buildingId: string } {
  const e = entryOf(world, id);
  if (!e) throw new AppError("not_found", `No entry ${id} on any job's thread.`);
  if (e.docId) throw badRequest(`Entry ${id} is the entry of ${e.docId}: decide that with \`review\` (docId ${e.docId}).`);
  if (e.level !== "manager") throw new AppError("conflict", e.level === "human" ? `Entry ${id} was passed up: it waits for a human.` : `Entry ${id} needs no answer (level ${e.level}).`);
  if (isAnswered(world, id)) throw new AppError("conflict", `Entry ${id} is already answered.`);
  const job = world.db.prepare("SELECT buildingId FROM jobs WHERE id = ?").get(e.jobId) as { buildingId: string };
  return { ...e, buildingId: job.buildingId };
}

/** The lane of the work an entry is about, so what follows it is charged where it was. */
const laneOfAssignment = (a: Assignment) => ({ lane: a.lane, grantId: a.grantId, keyResultId: a.keyResultId, gap: a.gap, sourceId: a.sourceId });

/**
 * The lane of work that follows an entry with no assignment behind it: its job's grant while that grant can still run
 * work; else, for a human's entry, directed work that cites the entry as its human source; else whatever the building's
 * rules resolve.
 */
function followLane(world: World, e: Entry): { laneOverride?: Lane } {
  const job = world.db.prepare("SELECT rule, pocketRef FROM jobs WHERE id = ?").get(e.jobId) as { rule: string; pocketRef: string | null } | undefined;
  const g = job?.rule === "ceiling" && job.pocketRef ? world.grants.get(job.pocketRef) : undefined;
  if (g && (g.status === "funded" || g.status === "checkpoint")) return { laneOverride: { lane: "grant", grantId: g.id, keyResultId: g.keyResultId, gap: null, sourceId: null } };
  if (e.authorKind === "human") return { laneOverride: { ...DIRECTED, sourceId: e.id } };
  return {};
}

/**
 * Decide a doc-less entry (see the file header). Returns the answer entry and the assignment it made, if any.
 * The caller checked the decider may review the entry's building.
 */
export function reviewEntry(world: World, entryId: string, decision: ReviewDecision, note: string, decider: Holder, opts: { waitFor?: WaitFor | null; lane?: LaneFields } = {}): { entry: Entry; assignment: Assignment | null } {
  note = note.trim();
  const e = requireOpenEntry(world, entryId);
  const dead = e.moved.kind === "dead-session";
  const building = world.buildings.require(e.buildingId, "building");
  let assignment: Assignment | null = null;
  if (decision === "redirect" && !note) throw badRequest("Redirect needs a note: it becomes the next assignment.");
  if (!dead && (decision === "continue" || decision === "stop")) {
    throw badRequest(`Entry ${entryId} is a human's ${e.moved.kind === "decision" ? "decision" : "message"}, not a report: approve it once you have taken it in (act on it first: \`tell\`, \`propose_grant\`, \`assign\`), or redirect it (your note becomes an assignment on the building queue).`);
  }
  const old = e.assignmentId ? world.assignments.get(e.assignmentId) : undefined;
  const left = e.body.trim() ? `\n\nWhat the session that ended without a report left (entry ${e.id}):\n\n${e.body.trim().slice(0, 4000)}` : "";
  if (dead && decision === "continue") {
    if (!old) throw badRequest(`Entry ${entryId} names no assignment to retry: redirect it with a note instead.`);
    // the same work again: same lane, same plan step, so its report queues the grant's next step like the first try would have
    assignment = createAssignment(world, {
      agentId: old.agentId, buildingId: old.buildingId, title: old.title, front: true, createdBy: decider, fromAssignmentId: old.id, waitFor: opts.waitFor,
      laneOverride: laneOfAssignment(old), model: old.model ?? undefined,
      description: `${old.description}${note ? `\n\nManager's note: ${note}` : ""}${left}`,
    });
    if (old.grantStep != null || old.pages?.length) assignment = world.assignments.patch(assignment.id, { ...(old.grantStep != null ? { grantStep: old.grantStep } : {}), ...(old.pages?.length ? { pages: old.pages } : {}) });
  } else if (decision === "redirect") {
    const manager = managerAgentOf(world, building);
    const agentId = old?.agentId ?? manager?.id;
    if (!agentId) throw badRequest(`${building.name} has no manager agent to queue the work to: approve the entry and \`assign\` the work yourself.`);
    assignment = createAssignment(world, {
      agentId, buildingId: e.buildingId, title: firstLine(note), createdBy: decider, fromAssignmentId: old?.id ?? null, waitFor: opts.waitFor,
      ...(opts.lane ? { lane: opts.lane } : old ? { laneOverride: laneOfAssignment(old) } : followLane(world, e)),
      description: dead ? `Your manager redirected this work after its session ended without a report:\n\n${note}\n\nThe work was "${old?.title ?? e.note}".${left}` : `${note}\n\nIt follows entry ${e.id} on job ${e.jobId}: ${e.note}${e.body.trim() ? `\n\n${e.body.trim().slice(0, 4000)}` : ""}`,
    });
  }
  const answer = answerEntry(world, e.id, decider, decision, note);
  if (!answer) throw new AppError("conflict", `Entry ${entryId} is already answered.`);
  return { entry: answer, assignment };
}

/**
 * Pass an entry up to the human (plan A2: "passing an entry up spawns nothing: it carries a note"). The manager can't
 * settle it, so its level becomes `human` and the manager's card is the ask in the Town Hall queue (structure checked
 * before it is filed). The human's decision comes back on the same thread (`askDecidedOnThread`).
 */
export function passUpWithAsk(world: World, me: Agent, e: Entry, buildingId: string, input: AskCardInput, note: string): { askId: string; folded: boolean } {
  const [a] = checkAskCards(world, [input]);
  refuseMissingStructure("pass-up", askStructure(a!.type, { ...a!, targetKind: a!.targetKind ?? null }));
  const { ask, folded } = createAsk(world, {
    type: a!.type, targetKind: a!.targetKind ?? null, targetId: a!.targetId ?? null, buildingId, sourceDocId: e.docId, by: me.id,
    title: a!.title, body: a!.body, branches: a!.branches, recommendation: a!.recommendation, claims: a!.claims, line: note || a!.title,
    // the ask remembers the entry it came from, so its decision lands back on that thread
    sourceEntryId: e.id,
  });
  setEntryLevel(world, e.id, "human");
  return { askId: ask.id, folded };
}

/**
 * A human decided an ask that was passed up from an entry: their words are a human entry on that thread, answering it,
 * at level manager when a manager or a fork raised it (the manager moves on it), else a record. One per entry that
 * raised the ask (a second manager's card folded into it hears too).
 */
export function askDecidedOnThread(world: World, ask: Pick<Ask, "id" | "title" | "sourceEntryId" | "sources">, by: string, said: string): Entry[] {
  const ids = [...new Set([ask.sourceEntryId, ...ask.sources.map((x) => x.entryId)].filter((x): x is string => !!x))];
  const out: Entry[] = [];
  for (const id of ids) {
    const raised = entryOf(world, id);
    if (!raised) continue;
    // the manager (or its fork's report) that raised it moves on the answer; anyone else's is a record
    const level = raised.authorKind === "manager" || raised.authorKind === "fork" ? "manager" : "none";
    const e = answerEntry(world, id, { kind: "user", id: by }, "ask-decided", `${world.nameOf(by)} decided your ask "${firstLine(ask.title, 100)}" (${ask.id}): ${said.slice(0, 1500)}`, { level });
    if (e) out.push(e);
  }
  return out;
}

/**
 * `ask` (plan dc_uwx045472m step 7: it replaces a rollup's Needs): a manager asks the humans the one thing only they can
 * settle, when the need appears. One manager entry at level human on a job's thread (the job named, else the grant or
 * retainer the card targets, else the building's own), and its card as an ask in the decision queue (structure checked).
 * The human's decision comes back on the same thread (`askDecidedOnThread`). A real-world act is `request_human`.
 */
export function askHumans(world: World, me: Agent, buildingId: string, input: AskCardInput & { jobId?: string; note?: string }): { askId: string; entryId: string; jobId: string; folded: boolean; warnings: string[] } {
  const [a] = checkAskCards(world, [input]);
  if (a!.type === "do") throw badRequest("A real-world act a human must carry out is `request_human` (it says why it is worth leaving the queue), not `ask`.");
  refuseMissingStructure("ask", askStructure(a!.type, { ...a!, targetKind: a!.targetKind ?? null }));
  const named = input.jobId ? jobThread(world, input.jobId)?.job : null;
  if (input.jobId && !named) throw badRequest(`${input.jobId} names no job: give a job id (jb_…), a grant, a schedule or an assignment, or leave jobId out.`);
  const onTarget = !named && a!.targetId && (a!.targetKind === "grant" || a!.targetKind === "retainer") ? jobThread(world, a!.targetId)?.job : null;
  const job = named ?? onTarget ?? jobThread(world, buildingId)?.job;
  if (!job) throw new AppError("conflict", "Your building has no thread to file the ask on.");
  if (job.buildingId !== buildingId) throw badRequest(`${job.id} is another building's job: an ask goes on a thread of your own building.`);
  const note = (input.note ?? "").trim();
  const entry = appendEntry(world, {
    jobId: job.id, authorKind: "manager", authorId: me.id, level: "human", note: a!.title,
    body: [note, a!.body.trim(), a!.recommendation.trim() ? `Recommendation: ${a!.recommendation.trim()}` : ""].filter(Boolean).join("\n\n"),
    moved: { kind: "ask", type: a!.type, ...(a!.targetId ? { targetId: a!.targetId } : {}) },
  });
  if (!entry) throw new AppError("conflict", `Could not write the ask on ${job.id}.`);
  const { ask, folded } = createAsk(world, {
    type: a!.type, targetKind: a!.targetKind ?? null, targetId: a!.targetId ?? null, buildingId, sourceDocId: null, by: me.id,
    title: a!.title, body: a!.body, branches: a!.branches, recommendation: a!.recommendation, claims: a!.claims, line: note || a!.title,
    sourceEntryId: entry.id,
  });
  // style rules never refuse a card: what it breaks is kept in the ask's history and said back to its author
  const warnings = askWarnings(a!.type, { ...a!, targetKind: a!.targetKind ?? null, dictionary: dictionaryPairs(world) });
  return { askId: ask.id, entryId: entry.id, jobId: job.id, folded, warnings };
}
