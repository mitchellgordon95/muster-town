/**
 * Archiving a report (Mitchell, 1:1 mt_cz11aqe81a): after reading a report a human does one of two things, talks to
 * its author (a 1:1) or archives it. Archive acknowledges it (decision "approve", no note, no assignment) and it
 * leaves the in-tray. There is no reply: the 1:1 replaced it.
 */
import type { Agent, Assignment, Doc } from "@muster-town/schema";
import { updateDoc } from "./domain.ts";
import { AppError } from "./errors.ts";
import { nowIso } from "./util.ts";
import type { World } from "./world.ts";

export interface ArchiveResult { doc: Doc; assignment: Assignment | null }

/**
 * Archive a report. `by` is the acting agent (a user's avatar) or null for system. Permission checks are the
 * caller's (ops). An already-decided report is left as it is.
 */
export function archiveReport(world: World, by: Agent | null, docId: string, opts: { deckSlide?: number } = {}): ArchiveResult {
  const report = world.docs.require(docId, "doc");
  if (report.type !== "report") throw new AppError("bad_request", `Doc ${docId} is a ${report.type}, not a report.`);
  if (report.decision && report.decision !== "pending") return { doc: report, assignment: null };
  const decidedBy = by ? world.holderOf(by).id : "system";
  return world.transaction(() => {
    const doc = updateDoc(world, docId, { decision: "approve", decidedBy, decidedAt: nowIso() });
    world.events.append({
      type: "doc.decision", agentId: world.agents.get(report.authorId)?.id ?? null, buildingId: doc.buildingId,
      text: `Archived: "${doc.title}"`,
      payload: { docId, decision: "approve", note: "", decidedBy, ...(opts.deckSlide ? { deckSlide: opts.deckSlide } : {}) },
    });
    return { doc, assignment: null };
  });
}
