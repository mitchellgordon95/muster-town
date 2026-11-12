/**
 * One loop (plan dc_uwx045472m step 5; grant gr_9mp6v6vv8k step 3): every new entry is answered at the lowest level that
 * can settle it. `answerReport` runs in `submit_report`'s transaction, right after the entry is written and the code's
 * own moves are made (the next step queued, the forecast filed, a parked continuation created, the job's row refreshed):
 *
 * - **code** settles what needs no judgment: a step report whose next step is queued; a step that left its grant held at
 *   the ceiling (the human's gate card answers it: level human); a parked report (its continuation resumes by itself);
 *   a retainer run's report (the run is closed); a directed (pocket) job's stop. The report doc is acknowledged by the
 *   town (`decidedBy: "system"`), so it never reaches the manager's in-tray, and the code's answer is an entry on the thread.
 * - **manager** settles the rest: a pivot, a last step (close_grant), a stop on a grant, an explorer's proposal to vet,
 *   a session that ended without a report (a `code` entry the code cannot settle), the manager's own report.
 * - **human**: rollups and unhomed visitors' reports (the Town Hall in-tray), unchanged.
 */
import type { Assignment, Doc } from "@muster-town/schema";
import { updateDoc } from "./domain.ts";
import { FALLBACK_REPORT_PREFIX } from "./prompts.ts";
import { nowIso } from "./util.ts";
import type { World } from "./world.ts";

type Level = "code" | "manager" | "human";

interface ReportFacts {
  doc: Doc;
  jobId: string | null;
  /** the session's assignment (done now) */
  assignment: Assignment | null;
  verdict: string;
  /** the grant's next step queued by this report */
  nextStep: Assignment | null;
  /** the continuation a `resumeWhen` parked */
  parked: { assignmentId: string; waitingOn: string } | null;
  /** the report goes to the Town Hall (a rollup, an unhomed visitor) */
  townHall: boolean;
  /** the building has a manager agent that works its in-tray */
  managed: boolean;
  /** the author is that manager */
  ownReport: boolean;
}

/** A dead session's fallback report (runtime work.ts): a code entry the code cannot settle. */
export const isFallbackReport = (title: string) => title.startsWith(FALLBACK_REPORT_PREFIX);

/** Why code settles this report, and at which level it then rests (code, or human when a gate holds it); null = the manager's. */
function codeSettles(world: World, f: ReportFacts): { level: Level; note: string } | null {
  if (f.townHall || f.ownReport || !f.managed || isFallbackReport(f.doc.title) || f.verdict === "pivot") return null;
  if (f.parked) return { level: "code", note: `Parked: it resumes by itself after ${f.parked.waitingOn} (${f.parked.assignmentId}).` };
  const a = f.assignment;
  const rule = f.jobId ? (world.db.prepare("SELECT rule FROM jobs WHERE id = ?").get(f.jobId) as { rule: string } | undefined)?.rule : undefined;
  if (rule === "ceiling" && a?.grantId && a.grantStep != null) {
    if (f.nextStep) return { level: "code", note: `Step ${a.grantStep + 2} queued by itself (${f.nextStep.id}); the forecast is filed.` };
    const g = world.grants.get(a.grantId);
    if (g?.status === "checkpoint" && f.verdict === "continue" && g.steps[a.grantStep + 1]) {
      return { level: "human", note: `The grant is held at its ceiling: step ${a.grantStep + 2} waits for a human to continue, adjust or cut it at the gate.` };
    }
    return null;
  }
  if (rule === "per-run") return { level: "code", note: "The retainer's run is closed." };
  if (rule === "pocket" && f.verdict === "stop") return { level: "code", note: "The directed work is done: its job closed." };
  return null;
}

/**
 * Answer a session's report entry (`en_<doc>`): settle it by code (the doc acknowledged by the town, an answer entry by
 * code), or leave it at the manager's (or the humans') level, pending. Returns where it rests.
 */
export function answerReport(world: World, f: ReportFacts): { level: Level; settled: boolean; note: string | null } {
  const entryId = `en_${f.doc.id}`;
  const settle = codeSettles(world, f);
  const level: Level = settle?.level ?? (f.townHall ? "human" : "manager");
  world.db.prepare("UPDATE entries SET level = ? WHERE id = ?").run(level, entryId);
  if (!settle) return { level, settled: false, note: null };
  const at = nowIso();
  updateDoc(world, f.doc.id, { decision: "approve", decisionNote: settle.note, decidedBy: "system", decidedAt: at });
  const ev = world.events.append({
    type: "doc.decision", agentId: f.doc.authorId, buildingId: f.doc.buildingId,
    text: `Settled by code: "${f.doc.title}" (${settle.note})`,
    payload: { docId: f.doc.id, decision: "approve", note: settle.note, decidedBy: "system", settledBy: "code", level: settle.level },
  });
  if (f.jobId) {
    const seq = (world.db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM entries WHERE jobId = ?").get(f.jobId) as { n: number }).n + 1;
    world.db.prepare(`INSERT OR IGNORE INTO entries (id, jobId, seq, authorKind, authorId, assignmentId, sessionId, pocket, tokens, moved, proposes, answers, level, note, body, docId, createdAt)
      VALUES (?, ?, ?, 'code', 'system', NULL, NULL, NULL, 0, ?, NULL, ?, 'none', ?, ?, ?, ?)`).run(
      `en_ev${ev.id}`, f.jobId, seq, JSON.stringify({ decision: "approve", ...(f.nextStep ? { queued: f.nextStep.id } : {}), ...(f.parked ? { parked: f.parked.assignmentId } : {}) }),
      entryId, settle.note, ev.text, f.doc.id, ev.ts,
    );
  }
  return { level: settle.level, settled: true, note: settle.note };
}

/**
 * What code settled in a building since `since` (newest first, at most `limit`): the manager reads them as a line, never
 * as in-tray rows to approve.
 */
export function settledByCode(world: World, buildingId: string, since: string, limit = 8): { docId: string; title: string; note: string; at: string }[] {
  return world.db.prepare(`SELECT e.docId, d.title, e.note, e.createdAt AS at FROM entries e JOIN jobs j ON j.id = e.jobId JOIN docs d ON d.id = e.docId
    WHERE j.buildingId = ? AND e.authorKind = 'code' AND e.answers IS NOT NULL AND e.createdAt > ? ORDER BY e.createdAt DESC, e.seq DESC LIMIT ?`).all(buildingId, since, limit) as { docId: string; title: string; note: string; at: string }[];
}
