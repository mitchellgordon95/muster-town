/**
 * Assignments that wait on a dependency (waiting design P1/P2). A pending assignment with `waitFor` is skipped by the
 * scheduler (`nextPending`); `checkWaits` (the runtime's tick) clears the wait once it holds, or after WAIT_TTL_MS
 * cancels the assignment into its building's in-tray. Waits are only set where a decision is already made (assign,
 * meeting decide, a manager's work/continue/redirect) or by an agent parking its own work (`submit_report` resumeWhen).
 */
import { WAIT_TTL_MS, WaitFor, waitKindsFor, type Assignment, type LiveCheck } from "@muster-town/schema";
import { runLiveCheck, verifyKeyResult, type CheckDeps } from "./ask-checks.ts";
import { createDoc, setAssignmentStatus } from "./domain.ts";
import { appendEntry, jobOf } from "./jobs.ts";
import { requestDone } from "./notices.ts";
import { AppError } from "./errors.ts";
import { nowIso, truncate } from "./util.ts";
import type { PrChecks, World } from "./world.ts";
import { stamp } from "./time.ts";

/**
 * Parse and check a wait at the point it is set: the thing waited on must exist; `after` at most 24 h ahead. A deploy
 * wait's `verifies` names key results of `ctx.grantId` only (the parking work's own grant), and only beside `checks`.
 */
export function validateWait(world: World, raw: unknown, ctx: { grantId?: string | null } = {}): WaitFor {
  const p = WaitFor.safeParse(raw);
  if (!p.success) throw new AppError("bad_request", `waitFor: expected {deploy: sha|"next"}, {assignment: id}, {decision: reportId}, {pr: number} or {after: iso} (${p.error.issues[0]?.message ?? "invalid"}).`);
  const w = p.data;
  const kind = Object.keys(w)[0];
  const mode = world.repoMode();
  if (!(waitKindsFor(mode) as string[]).includes(kind)) {
    throw new AppError("bad_request", mode === "none"
      ? `waitFor.${kind}: this collective has no code repo, so nothing here redeploys or runs CI. Wait on {assignment}, {decision} or {after} instead.`
      : `waitFor.deploy: this collective's repo is not the one this server runs, so its redeploys don't follow your commits. Wait on {pr}, {assignment}, {decision} or {after} instead.`);
  }
  if ("assignment" in w) world.assignments.require(w.assignment, "assignment");
  if ("decision" in w) {
    const d = world.docs.require(w.decision, "doc");
    if (d.type !== "report") throw new AppError("bad_request", `waitFor.decision: ${d.id} is a ${d.type}, not a report.`);
  }
  if ("after" in w && Date.parse(w.after) - Date.now() > WAIT_TTL_MS) throw new AppError("bad_request", "waitFor.after: at most 24 h ahead.");
  if ("deploy" in w && w.verifies) {
    if (!w.checks) throw new AppError("bad_request", "waitFor.verifies: name the live checks that verify them too (checks: [{kind, ref}]).");
    for (const id of w.verifies) {
      const kr = world.keyResults.get(id);
      if (!kr) throw new AppError("not_found", `waitFor.verifies: no key result ${id}.`);
      if (!ctx.grantId || kr.grantId !== ctx.grantId) {
        throw new AppError("bad_request", `waitFor.verifies: ${id} is a key result of ${kr.grantId ?? "no grant"}, not of ${ctx.grantId ? `this work's grant ${ctx.grantId}` : "this work (it runs on no grant)"}. A live check verifies only its own grant's key results.`);
      }
    }
  }
  return w;
}

/** "redeploy with 8842a21", "Root's “Bank building” to finish", … (UI and events). */
export function describeWait(world: World, w: WaitFor): string {
  if ("deploy" in w) {
    const d = w.deploy === "next" ? "the next redeploy" : `a redeploy with ${w.deploy.slice(0, 7)}`;
    return w.checks ? `${d}, then ${w.checks.length} live check${w.checks.length === 1 ? "" : "s"}` : d;
  }
  if ("assignment" in w) {
    const a = world.assignments.get(w.assignment);
    return a ? `${world.nameOf(a.agentId)}'s "${truncate(a.title, 60)}" to finish` : `assignment ${w.assignment} to finish`;
  }
  if ("decision" in w) {
    const d = world.docs.get(w.decision);
    return d ? `a decision on "${truncate(d.title, 60)}"` : `a decision on ${w.decision}`;
  }
  if ("pr" in w) {
    const c = world.host.prChecks?.(w.pr);
    const how = c && c.state !== "pending" ? ` (${c.state}${c.failed?.length ? `: ${c.failed.join(", ")}` : ""})` : "";
    return `PR #${w.pr}'s checks to finish${w.merge ? " and the town to merge it" : ""}${how}`;
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

/**
 * Whether the wait holds now. `deploy` and `pr` need the runtime (`world.host`): without one they never hold (and expire).
 * A `pr` wait holds once the PR's checks all finished, passed or failed (the parked work reads which), or it is closed.
 */
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
  if ("pr" in w) {
    const c = world.host.prChecks?.(w.pr);
    // merge when green: passed is not the end, the poller merges it (merged) or says why not (failed) on the same read
    return !!c && c.state !== "pending" && !(w.merge && c.state === "passed");
  }
  return Date.parse(w.after) <= at.getTime();
}

/**
 * Merge when green (grant gr_rlt0ctnhqk): the PR a `{pr, merge: true}` wait names was merged, so the parked work is done
 * with no new session. The continuation closes as done, its job's thread gets "merged PR #N as <sha>", and a parked grant
 * step queues the plan's next step as its report would have (from the report that parked it).
 */
function closeMerged(world: World, a: Assignment, pr: number, c: PrChecks): Assignment {
  const sha = c.mergeSha ?? c.sha ?? "";
  const who = c.mergedBy === "town" ? "The town merged" : "Someone merged";
  return closeWithoutSession(world, a, {
    suffix: "merged", note: `merged PR #${pr} as ${sha.slice(0, 8)}`,
    body: `${who} PR #${pr} as ${sha} once its checks passed${c.total ? ` (${c.done} of ${c.total})` : ""}. The parked work "${truncate(a.title, 120)}" is done; no session ran for it.`,
    moved: { kind: "merged", pr, sha, by: c.mergedBy ?? null },
  }, () => world.events.append({ type: "pr.merged", agentId: a.agentId, buildingId: a.buildingId, text: `${who} PR #${pr} as ${sha.slice(0, 8)}: "${truncate(a.title, 80)}" is done with no new session`, payload: { assignmentId: a.id, pr, sha, by: c.mergedBy ?? null } }));
}

/**
 * Parked work the town finished itself (a merged PR, passed live checks): the continuation closes as done, its job's
 * thread gets a `code` entry, a parked grant step queues the plan's next step as its report would have (from the report
 * that parked it), and a human's own request whose last work this was gets its "Done" notice.
 */
function closeWithoutSession(world: World, a: Assignment, e: { suffix: string; note: string; body: string; moved: Record<string, unknown> }, also: (done: Assignment) => void): Assignment {
  return world.transaction(() => {
    const done = setAssignmentStatus(world, a.id, "done", { waitFor: null });
    appendEntry(world, { id: `en_${a.id}_${e.suffix}`, jobId: jobOf(a).id, authorKind: "code", authorId: "system", level: "none", assignmentId: a.id, note: e.note, body: e.body, moved: e.moved });
    also(done);
    if (a.grantStep != null && a.fromReportId) world.grantDesk.queueNextStep(done, a.fromReportId, "continue");
    const parkedBy = a.fromReportId ? world.docs.get(a.fromReportId) : null;
    if (parkedBy) requestDone(world, parkedBy, done);
    return done;
  });
}

type CheckResult = LiveCheck & { ok: boolean; note: string };
/** A live check in words: "GET /api/health /commit abc1234" or "https://muster.town/ (status 200, contains "Muster")". */
function checkLine(c: CheckResult): string {
  const expect = [c.status !== undefined ? `status ${c.status}` : "", c.contains !== undefined ? `contains "${truncate(c.contains, 60)}"` : ""].filter(Boolean).join(", ");
  return `${c.ok ? "passed" : "FAILED"}: ${c.kind} ${truncate(c.ref, 160)}${expect ? ` (expected ${expect})` : ""}: ${c.note}`;
}

/** The live checks running now, per world: one run per assignment at a time (a restart drops them and the next tick runs them again). */
const running = new WeakMap<World, Set<string>>();

/**
 * Live checks on a deploy wait (grant gr_qg42b4guky): the deploy is live, so run every check. All pass = the parked work
 * closes as done with no new session (entry "live checks passed"), each `verifies` key result of its own grant turns met.
 * Any fails = the wait clears and the continuation starts with each check's result in its description. Returns the
 * assignment as it ends, or null when it changed under the checks (cancelled, re-waited) and nothing was written.
 */
async function settleLiveChecks(world: World, a: Assignment, checks: LiveCheck[], verifies: string[], deps: CheckDeps): Promise<Assignment | null> {
  const results: CheckResult[] = [];
  for (const c of checks) results.push({ ...c, ...(await runLiveCheck(world, c, deps)) });
  const cur = world.assignments.get(a.id);
  if (!cur || cur.status !== "pending" || JSON.stringify(cur.waitFor) !== JSON.stringify(a.waitFor)) return null;
  const lines = results.map(checkLine);
  const live = world.host.commit ? ` on live ${world.host.commit.slice(0, 8)}` : "";
  const payload = { assignmentId: a.id, checks: results.map((r) => ({ kind: r.kind, ref: r.ref, ok: r.ok, note: r.note })) };
  if (results.every((r) => r.ok)) {
    // verify only the parking work's own grant's key results (validateWait refused others; re-checked here)
    const mine = verifies.filter((id) => !!a.grantId && world.keyResults.get(id)?.grantId === a.grantId);
    return closeWithoutSession(world, cur, {
      suffix: "live-checks", note: `live checks passed (${results.length})${mine.length ? `; verified ${mine.join(", ")}` : ""}`,
      body: `The town ran ${results.length} live check${results.length === 1 ? "" : "s"}${live} once the deploy was live:\n\n${lines.map((l) => `- ${l}`).join("\n")}\n\nAll passed, so the parked work "${truncate(a.title, 120)}" is done; no session ran for it.${mine.length ? ` Key results verified: ${mine.join(", ")}.` : ""}`,
      moved: { kind: "live-checks", passed: true, checks: payload.checks, verified: mine },
    }, () => {
      for (const id of mine) verifyKeyResult(world, id, `live checks passed: ${results.map((r) => r.note).join("; ").slice(0, 300)}`, { open: true });
      world.events.append({ type: "live.checked", agentId: a.agentId, buildingId: a.buildingId, text: `Live checks passed: "${truncate(a.title, 80)}" is done with no new session`, payload: { ...payload, passed: true, verified: mine } });
    });
  }
  const failed = results.filter((r) => !r.ok).length;
  return world.transaction(() => {
    const u = world.assignments.upsert({ ...cur, waitFor: null, description: `${cur.description}\n\nLive checks when this resumed${live}: ${failed} of ${results.length} failed.\n${lines.map((l) => `- ${l}`).join("\n")}`, updatedAt: nowIso() });
    appendEntry(world, { id: `en_${a.id}_live-checks`, jobId: jobOf(a).id, authorKind: "code", authorId: "system", level: "none", assignmentId: a.id, note: `live checks failed (${failed} of ${results.length}); the work resumes`, body: lines.map((l) => `- ${l}`).join("\n"), moved: { kind: "live-checks", passed: false, checks: payload.checks } });
    world.events.append({ type: "assignment.status", agentId: a.agentId, buildingId: a.buildingId, text: `${world.nameOf(a.agentId)}'s "${truncate(a.title, 80)}" unblocked: ${failed} of ${results.length} live checks failed`, payload: { ...payload, status: "pending", from: "pending", unblocked: true, passed: false } });
    return u;
  });
}

/** The PR's outcome, for a continuation that wakes on a `{pr}` wait: what to fix (failed checks, a conflict, a refused merge). */
function prOutcome(pr: number, c: PrChecks | undefined): string {
  if (!c) return "";
  return `\n\nPR #${pr} when this resumed: ${c.state}${c.failed?.length ? ` (${c.failed.join("; ")})` : ""}${c.sha ? ` on ${c.sha.slice(0, 8)}` : ""}.`;
}

/**
 * Clear met waits (event "unblocked: …"); cancel ones unmet past WAIT_TTL_MS into the in-tray. A merge-when-green wait
 * whose PR merged closes its work as done instead (`merged`). Cheap: one indexed query.
 */
export function checkWaits(world: World, at: Date = new Date(), deps: CheckDeps = {}): { unblocked: Assignment[]; expired: Assignment[]; merged: Assignment[]; checking: Promise<Assignment | null>[] } {
  const unblocked: Assignment[] = [], expired: Assignment[] = [], merged: Assignment[] = [], checking: Promise<Assignment | null>[] = [];
  const cutoff = new Date(at.getTime() - WAIT_TTL_MS).toISOString();
  const inFlight = running.get(world) ?? new Set<string>();
  running.set(world, inFlight);
  for (const a of world.assignments.where("status = 'pending' AND waitFor IS NOT NULL", [], "ORDER BY createdAt")) {
    if (inFlight.has(a.id)) continue; // its live checks are running: the run settles it
    const what = describeWait(world, a.waitFor!);
    if (waitMet(world, a, at)) {
      const w = a.waitFor!;
      // live checks (gr_qg42b4guky): the deploy is live; the checks run off the tick and settle the work when they finish
      if ("deploy" in w && w.checks) {
        inFlight.add(a.id);
        checking.push(settleLiveChecks(world, a, w.checks, w.verifies ?? [], deps)
          .catch((e: unknown) => { console.warn(`[waits] live checks of ${a.id} failed: ${e instanceof Error ? e.message : String(e)}`); return null; })
          .finally(() => inFlight.delete(a.id)));
        continue;
      }
      const pr = "pr" in w ? world.host.prChecks?.(w.pr) : undefined;
      if ("pr" in w && w.merge && pr?.state === "merged") {
        merged.push(closeMerged(world, a, w.pr, pr));
        continue;
      }
      const u = world.assignments.upsert({ ...a, waitFor: null, description: "pr" in w ? `${a.description}${prOutcome(w.pr, pr)}` : a.description, updatedAt: nowIso() });
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
  return { unblocked, expired, merged, checking };
}
