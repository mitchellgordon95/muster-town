/**
 * Assignments that wait on a dependency (waiting design P1/P2). A pending assignment with `waitFor` is skipped by the
 * scheduler (`nextPending`); `checkWaits` (the runtime's tick) clears the wait once it holds, or after WAIT_TTL_MS
 * cancels the assignment into its building's in-tray. Waits are only set where a decision is already made (assign,
 * meeting decide, a manager's work/continue/redirect) or by an agent parking its own work (`submit_report` resumeWhen).
 */
import { WAIT_TTL_MS, WaitFor, type Assignment } from "@muster-town/schema";
import { createDoc, setAssignmentStatus } from "./domain.ts";
import { AppError } from "./errors.ts";
import { nowIso, truncate } from "./util.ts";
import type { World } from "./world.ts";
import { stamp } from "./time.ts";

/** Parse and check a wait at the point it is set: the thing waited on must exist; `after` at most 24 h ahead. */
export function validateWait(world: World, raw: unknown): WaitFor {
  const p = WaitFor.safeParse(raw);
  if (!p.success) throw new AppError("bad_request", `waitFor: expected {deploy: sha|"next"}, {assignment: id}, {decision: reportId} or {after: iso} (${p.error.issues[0]?.message ?? "invalid"}).`);
  const w = p.data;
  if ("assignment" in w) world.assignments.require(w.assignment, "assignment");
  if ("decision" in w) {
    const d = world.docs.require(w.decision, "doc");
    if (d.type !== "report") throw new AppError("bad_request", `waitFor.decision: ${d.id} is a ${d.type}, not a report.`);
  }
  if ("after" in w && Date.parse(w.after) - Date.now() > WAIT_TTL_MS) throw new AppError("bad_request", "waitFor.after: at most 24 h ahead.");
  return w;
}

/** "redeploy with 8842a21", "Root's “Bank building” to finish", … (UI and events). */
export function describeWait(world: World, w: WaitFor): string {
  if ("deploy" in w) return w.deploy === "next" ? "the next redeploy" : `a redeploy with ${w.deploy.slice(0, 7)}`;
  if ("assignment" in w) {
    const a = world.assignments.get(w.assignment);
    return a ? `${world.nameOf(a.agentId)}'s "${truncate(a.title, 60)}" to finish` : `assignment ${w.assignment} to finish`;
  }
  if ("decision" in w) {
    const d = world.docs.get(w.decision);
    return d ? `a decision on "${truncate(d.title, 60)}"` : `a decision on ${w.decision}`;
  }
  return stamp(w.after);
}

/**
 * The last assignment of `a`'s park chain: follow each park continuation (`parked`, `fromAssignmentId` = the one that
 * parked) to the newest. A `{assignment}` wait reads this one, so it holds while the work is parked (done with a pending
 * or running continuation) and releases once the chain ends done without a continuation, or cancelled.
 */
export function chainTip(world: World, a: Assignment): Assignment {
  const seen = new Set([a.id]);
  for (let cur = a; ;) {
    const next = world.assignments.first("fromAssignmentId = ? AND parked IS NOT NULL", [cur.id], "ORDER BY createdAt DESC, rowid DESC");
    if (!next || seen.has(next.id)) return cur;
    seen.add(next.id);
    cur = next;
  }
}

/** Whether the wait holds now. `deploy` needs the runtime (`world.host`): without one it never holds (and expires). */
export function waitMet(world: World, a: Assignment, at: Date = new Date()): boolean {
  const w = a.waitFor;
  if (!w) return true;
  if ("deploy" in w) {
    if (w.deploy === "next") return !!world.host.startedAt && world.host.startedAt > a.createdAt;
    return world.host.isLive?.(w.deploy) ?? false;
  }
  if ("assignment" in w) {
    const dep = world.assignments.get(w.assignment);
    if (!dep) return true;
    const tip = chainTip(world, dep);
    return tip.status === "done" || tip.status === "cancelled";
  }
  if ("decision" in w) {
    const d = world.docs.get(w.decision);
    return !d || (!!d.decision && d.decision !== "pending");
  }
  return Date.parse(w.after) <= at.getTime();
}

/** Clear met waits (event "unblocked: …"); cancel ones unmet past WAIT_TTL_MS into the in-tray. Cheap: one indexed query. */
export function checkWaits(world: World, at: Date = new Date()): { unblocked: Assignment[]; expired: Assignment[] } {
  const unblocked: Assignment[] = [], expired: Assignment[] = [];
  const cutoff = new Date(at.getTime() - WAIT_TTL_MS).toISOString();
  for (const a of world.assignments.where("status = 'pending' AND waitFor IS NOT NULL", [], "ORDER BY createdAt")) {
    const what = describeWait(world, a.waitFor!);
    if (waitMet(world, a, at)) {
      const u = world.assignments.upsert({ ...a, waitFor: null, updatedAt: nowIso() });
      world.events.append({ type: "assignment.status", agentId: a.agentId, buildingId: a.buildingId, text: `${world.nameOf(a.agentId)}'s "${truncate(a.title, 80)}" unblocked: ${what} happened`, payload: { assignmentId: a.id, status: "pending", from: "pending", unblocked: true } });
      unblocked.push(u);
    } else if (a.createdAt <= cutoff) {
      const name = world.nameOf(a.agentId);
      world.transaction(() => {
        expired.push(setAssignmentStatus(world, a.id, "cancelled"));
        createDoc(world, {
          type: "report", state: "building", decision: "pending", buildingId: a.buildingId,
          authorId: a.agentId, authorKind: "agent", assignmentId: a.id, tags: ["wait-expired"],
          title: `${name}'s assignment never unblocked: ${a.title}`,
          body: [
            `Written by the town, not by ${name}: this assignment was queued on ${stamp(a.createdAt)} waiting on ${what}, which didn't happen within 24 hours, so it was cancelled.`,
            `## Summary\n\nWait expired: ${a.title}`,
            `## The assignment\n\n${a.description}`,
            `## Proposal for next session\n\n${a.title}`,
            "Acknowledge to drop it, Continue to queue it again without the wait, or Redirect it with a note.",
          ].join("\n\n"),
        }, `${name}'s assignment never unblocked: ${a.title}`);
      });
    }
  }
  return { unblocked, expired };
}
