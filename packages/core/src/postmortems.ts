import type { Assignment, Doc, KeyResult } from "@muster-town/schema";
import { createAssignment, createDoc, managerAgentOf } from "./domain.ts";
import type { Actor } from "./ops.ts";
import { holderOf } from "./permissions.ts";
import { nowIso } from "./util.ts";
import type { World } from "./world.ts";

/**
 * Postmortems on missed key results (docs/goals.md "Postmortems on missed KRs", build step 6). A human marking a key
 * result missed (in the goal editor, or archiving it in a reorg) files their why-line as a note, the human source, and
 * that note queues one small directed assignment on the building whose grant named the key result (else the building
 * that proposed it). The assignment's final report becomes the key result's `postmortemDocId`. One per key result.
 */

/** The note's tag that ties it (and so its assignment and report) to the key result. */
export const postmortemTag = (krId: string) => `postmortem-of:${krId}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The postmortem note already filed for this key result, if any (two are never queued for one key result). */
export function postmortemNote(world: World, krId: string): Doc | undefined {
  return world.docs.first("type = 'note' AND tags LIKE ?", [`%"${postmortemTag(krId)}"%`]);
}

/** The building that runs the postmortem: the one whose grant named the key result (the latest), else the one that proposed it. */
export function postmortemBuilding(world: World, kr: KeyResult): string {
  return world.grants.where("keyResultId = ?", [kr.id], "ORDER BY createdAt DESC, rowid DESC")[0]?.buildingId ?? kr.buildingId;
}

/** Called when a key result turns missed: file the why-line note and queue the postmortem (once). Returns the assignment, if one was queued. */
export function queuePostmortem(world: World, actor: Actor, kr: KeyResult, why: string): Assignment | null {
  if (kr.postmortemDocId || postmortemNote(world, kr.id)) return null;
  const by = actor ? holderOf(actor) : { kind: "user" as const, id: "system" };
  const bid = postmortemBuilding(world, kr);
  const b = world.buildings.get(bid);
  const line = why.trim() || "(no reason given)";
  const goal = kr.goalId ? world.goalTree.get(kr.goalId) : undefined;
  const note = createDoc(world, {
    type: "note", state: "building", buildingId: bid, authorId: by.id, authorKind: by.kind === "agent" ? "agent" : "user",
    title: `Missed: ${clip(kr.text, 100)}`, tags: ["postmortem", postmortemTag(kr.id)],
    body: `# Key result missed\n\n**Key result:** ${kr.text} (${kr.id})${goal ? `\n\n**Goal:** ${goal.text} (${goal.id})` : ""}\n\n## Why\n\n${line}\n\nMarked missed by ${world.nameOf(by.id)}. A postmortem is queued on ${b?.name ?? bid}; its report links back to the key result.`,
  });
  const mgr = b ? managerAgentOf(world, b) : undefined;
  if (!mgr) return null;
  return createAssignment(world, {
    agentId: mgr.id, queue: "building", buildingId: bid, createdBy: by.kind === "agent" ? { kind: "system", id: "system" } : by,
    title: `Postmortem on ${kr.id}: ${clip(kr.text, 80)}`,
    description: `A human marked the key result "${kr.text}" (${kr.id}${goal ? `, under the goal "${goal.text}" (${goal.id})` : ""}) missed. Their note ${note.id} says why: ${line}\n\nWrite the postmortem: what we planned, what happened, what we'd do differently, and whether the goal needs a new key result (if it does, propose it with propose_key_result and name it in the report). One screen. No new work: read the grant, its reports and the event log, then submit one report. Its report links back to the key result as its postmortem.`,
    lane: { lane: "directed", sourceId: note.id },
  });
}

/** Called when a report is filed: a postmortem assignment's final (not parked) report becomes the key result's postmortem. */
export function linkPostmortem(world: World, asg: Assignment | undefined, report: Doc): void {
  if (!asg?.sourceId || report.tags.includes("parked")) return;
  const note = world.docs.get(asg.sourceId);
  const tag = note?.type === "note" ? note.tags.find((t) => t.startsWith("postmortem-of:")) : undefined;
  if (!tag) return;
  const kr = world.keyResults.get(tag.slice("postmortem-of:".length));
  if (!kr || kr.postmortemDocId) return;
  world.docs.upsert({ ...report, tags: [...new Set([...report.tags, "postmortem", tag])], updatedAt: nowIso() });
  // updatedAt stays: it dates the missed mark (the Spend tab's results window)
  world.keyResults.upsert({ ...kr, postmortemDocId: report.id });
  world.events.append({ type: "kr.updated", agentId: report.authorKind === "agent" ? report.authorId : null, buildingId: kr.buildingId, text: `Postmortem filed on a missed key result: ${kr.text}`, payload: { keyResultId: kr.id, status: kr.status, from: kr.status, postmortemDocId: report.id, by: report.authorId, byKind: report.authorKind, edited: false } });
}
