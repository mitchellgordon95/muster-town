import type { Entry, EntryMoved, Grant, Job, JobClosedAs, JobRule, JobStatus, Schedule } from "@muster-town/schema";
import { AppError } from "./errors.ts";
import { newId } from "./util.ts";
import type { World } from "./world.ts";

/**
 * The job abstraction, step 1 (plan dc_uwx045472m §A1, grant gr_9mp6v6vv8k): read only. Every piece of work is a job
 * with one budget rule, and its record is a thread of entries. Nothing writes either table yet but `syncJobs`, which
 * back-fills them from the old records at boot (and, at most once a minute, before GET /api/jobs/:id reads one):
 *
 * - jobs: one `ceiling` job per grant (pocketRef = the grant), one `per-run` job per retainer schedule (the schedule),
 *   one `chunk` job per exploration chunk (its reservation, else its chain), one `pocket` job per directed human source
 *   and building (the source), and one `building` job per building (the building id). Status and title follow the
 *   lifecycle object on every sync.
 * - entries: one per report doc (on its assignment's job, else its building's; its title as the note, its body left in the
 *   doc, `moved.docId`, until the plan's step 9b), one per report decision (answering the report's entry) and one per
 *   grant history line. `ref` names what an entry was read from, so a sync is idempotent.
 *
 * Step 2 of the plan makes submit_report write the entry itself; the back-fill then finds its `ref` and skips it.
 */

type JobKey = { buildingId: string; rule: JobRule; pocketRef: string };
const keyOf = (k: JobKey) => `${k.buildingId}\u0000${k.rule}\u0000${k.pocketRef}`;

interface AssignmentRow {
  id: string; buildingId: string; title: string; status: string; lane: string; grantId: string | null; sourceId: string | null;
  reservationId: string | null; chainId: string | null; createdBy: string; createdAt: string;
}

/** The job an assignment's sessions draw on: its grant, its retainer, its exploration chunk, its human source, else its building. */
function jobKeyOf(a: AssignmentRow, grants: Map<string, Grant>, retainers: Map<string, Schedule>): JobKey {
  if (a.lane === "grant" && a.grantId) {
    const g = grants.get(a.grantId);
    if (g) return { buildingId: g.buildingId, rule: "ceiling", pocketRef: g.id };
  }
  if (a.lane === "retainer" && a.sourceId) {
    const s = retainers.get(a.sourceId);
    if (s) return { buildingId: s.buildingId, rule: "per-run", pocketRef: s.id };
  }
  if (a.lane === "exploration") return { buildingId: a.buildingId, rule: "chunk", pocketRef: a.reservationId ?? a.chainId ?? a.id };
  if (a.lane === "directed" && a.sourceId) return { buildingId: a.buildingId, rule: "pocket", pocketRef: a.sourceId };
  return { buildingId: a.buildingId, rule: "building", pocketRef: a.buildingId };
}

/** A grant's status as a job's: checkpoint and stopping are held; closed and rejected close with how. */
function grantStatus(g: Grant): { status: JobStatus; closedAs: JobClosedAs | null } {
  switch (g.status) {
    case "draft": case "proposed": return { status: "proposed", closedAs: null };
    case "countered": return { status: "countered", closedAs: null };
    case "funded": return { status: "open", closedAs: null };
    case "checkpoint": case "stopping": return { status: "held", closedAs: null };
    case "rejected": return { status: "closed", closedAs: g.history.some((h) => h.action === "withdraw") ? "withdrawn" : "rejected" };
    case "closed": return { status: "closed", closedAs: g.outcome === "cut" ? "cut" : g.outcome === "stopped" ? "stopped" : g.history.some((h) => h.action === "withdraw") ? "withdrawn" : "done" };
  }
}

/** A retainer schedule's status as a job's. */
function retainerStatus(s: Schedule): { status: JobStatus; closedAs: JobClosedAs | null } {
  if (s.retainer === "rejected") return { status: "closed", closedAs: "rejected" };
  if (s.status === "ended") return { status: "closed", closedAs: "done" };
  if (s.retainer === "asked") return { status: "proposed", closedAs: null };
  if (s.retainer === "countered") return { status: "countered", closedAs: null };
  return { status: "open", closedAs: null };
}

/** How an agent's or user's id writes an entry: a user is human, "system" is code, a building's manager is manager, else a fork. */
function authorKindOf(world: World, id: string | null | undefined, managers: Set<string>): Entry["authorKind"] {
  if (!id || id === "system") return "code";
  if (id.startsWith("us_")) return "human";
  if (managers.has(id)) return "manager";
  const a = world.agents.get(id);
  if (a?.kind === "human") return "human";
  return "fork";
}

interface Pending { id: string; jobId: string; at: string; entry: Omit<Entry, "id" | "seq" | "jobId"> }

/**
 * Back-fill jobs and entries from the old records (see the file comment). Idempotent: a job is keyed by
 * (building, rule, pocketRef) and an entry by its `ref`. Returns what it added.
 */
export function syncJobs(world: World): { jobs: number; entries: number } {
  return world.transaction(() => syncJobsTx(world));
}

function syncJobsTx(world: World): { jobs: number; entries: number } {
  const db = world.db;
  const buildings = world.buildings.all();
  const buildingGoal = new Map(buildings.map((b) => [b.id, b.goalId ?? null]));
  const managers = new Set(buildings.map((b) => b.managerAgentId).filter((x): x is string => !!x));
  const grants = new Map(world.grants.all().map((g) => [g.id, g]));
  const retainers = new Map(world.schedules.where("lane = 'retainer' OR retainer != 'none'").map((s) => [s.id, s]));
  const existing = new Map(world.jobs.all().map((j) => [keyOf(j), j]));
  let addedJobs = 0;

  /** Insert the job, or bring its status, closedAs and title up to date. */
  const ensure = (k: JobKey, fields: { title: string; status: JobStatus; closedAs: JobClosedAs | null; goalId: string | null; createdBy: string; createdAt: string }): void => {
    if (!buildingGoal.has(k.buildingId)) return;
    const had = existing.get(keyOf(k));
    if (had) {
      if (had.status !== fields.status || had.closedAs !== fields.closedAs || had.title !== fields.title) {
        existing.set(keyOf(k), world.jobs.upsert({ ...had, status: fields.status, closedAs: fields.closedAs, title: fields.title }));
      }
      return;
    }
    existing.set(keyOf(k), world.jobs.upsert({ id: newId("jb"), ...k, ...fields, createdBy: fields.createdBy || "system" }));
    addedJobs++;
  };

  for (const b of buildings) ensure({ buildingId: b.id, rule: "building", pocketRef: b.id }, { title: b.name, status: "open", closedAs: null, goalId: b.goalId ?? null, createdBy: b.createdBy ?? "system", createdAt: b.createdAt });
  for (const g of grants.values()) {
    ensure({ buildingId: g.buildingId, rule: "ceiling", pocketRef: g.id }, { title: g.title || g.objective, ...grantStatus(g), goalId: g.goalId ?? buildingGoal.get(g.buildingId) ?? null, createdBy: g.proposedBy, createdAt: g.createdAt });
  }
  for (const s of retainers.values()) {
    ensure({ buildingId: s.buildingId, rule: "per-run", pocketRef: s.id }, { title: s.title, ...retainerStatus(s), goalId: buildingGoal.get(s.buildingId) ?? null, createdBy: s.createdBy, createdAt: s.createdAt });
  }

  // chunk and pocket jobs: one per exploration chunk and per (building, human source), from the assignments that ran them
  const assignments = db.prepare("SELECT id, buildingId, title, status, lane, grantId, sourceId, reservationId, chainId, createdBy, createdAt FROM assignments ORDER BY createdAt, rowid").all() as AssignmentRow[];
  const byAssignment = new Map<string, AssignmentRow>();
  const groups = new Map<string, { k: JobKey; rows: AssignmentRow[] }>();
  for (const a of assignments) {
    byAssignment.set(a.id, a);
    const k = jobKeyOf(a, grants, retainers);
    if (k.rule !== "chunk" && k.rule !== "pocket") continue;
    const g = groups.get(keyOf(k));
    if (g) g.rows.push(a); else groups.set(keyOf(k), { k, rows: [a] });
  }
  const sourceTitle = (ref: string): string | null => {
    if (ref.startsWith("mt_")) return world.meetings.get(ref)?.title ?? null;
    if (ref.startsWith("dc_")) return world.docs.get(ref)?.title ?? null;
    return null;
  };
  for (const { k, rows } of groups.values()) {
    const live = rows.some((r) => r.status === "pending" || r.status === "active");
    const first = rows[0]!;
    ensure(k, { title: (k.rule === "pocket" ? sourceTitle(k.pocketRef) : null) ?? first.title, status: live ? "open" : "closed", closedAs: live ? null : "done", goalId: buildingGoal.get(k.buildingId) ?? null, createdBy: first.createdBy, createdAt: first.createdAt });
  }
  const jobFor = (k: JobKey) => existing.get(keyOf(k));

  // entries: what is already filed, by ref
  const known = new Set((db.prepare("SELECT ref FROM entries WHERE ref IS NOT NULL").all() as { ref: string }[]).map((r) => r.ref));
  const pending: Pending[] = [];
  const reportEntryId = new Map<string, string>();
  for (const r of db.prepare("SELECT ref, id FROM entries WHERE ref LIKE 'dc_%' AND ref NOT LIKE '%#%'").all() as { ref: string; id: string }[]) reportEntryId.set(r.ref, r.id);

  // one entry per report doc (drafts are nobody's record) and one per decision on it
  const reports = world.docs.where("type = 'report' AND state != 'draft' AND (id NOT IN (SELECT ref FROM entries WHERE ref IS NOT NULL) OR (decision IS NOT NULL AND decision != 'pending' AND id || '#decision' NOT IN (SELECT ref FROM entries WHERE ref IS NOT NULL)))", [], "ORDER BY createdAt, rowid");
  for (const d of reports) {
    const a = d.assignmentId ? byAssignment.get(d.assignmentId) : undefined;
    const k = a ? jobKeyOf(a, grants, retainers) : d.buildingId ? { buildingId: d.buildingId, rule: "building" as const, pocketRef: d.buildingId } : null;
    const job = k ? jobFor(k) : undefined;
    if (!job) continue;
    const decided = !!d.decision && d.decision !== "pending";
    if (!known.has(d.id)) {
      const id = newId("en");
      reportEntryId.set(d.id, id);
      pending.push({ id, jobId: job.id, at: d.createdAt, entry: {
        authorKind: authorKindOf(world, d.authorId, managers), authorId: d.authorId, assignmentId: d.assignmentId ?? null, sessionId: d.sessionId ?? null,
        pocket: job.pocketRef, tokens: Math.max(0, d.tokens ?? 0), moved: { docId: d.id }, proposes: d.verdict ?? null, answers: null,
        level: d.decision === "pending" ? "manager" : "none", note: d.title, body: "", ref: d.id, createdAt: d.createdAt,
      } });
    }
    if (decided && !known.has(`${d.id}#decision`)) {
      const at = d.decidedAt ?? d.updatedAt;
      pending.push({ id: newId("en"), jobId: job.id, at, entry: {
        authorKind: authorKindOf(world, d.decidedBy, managers), authorId: d.decidedBy ?? null, assignmentId: null, sessionId: null,
        pocket: job.pocketRef, tokens: 0, moved: { action: d.decision!, docId: d.id }, proposes: null, answers: reportEntryId.get(d.id) ?? null,
        level: "none", note: d.decisionNote ? `${d.decision}: ${d.decisionNote}` : d.decision!, body: "", ref: `${d.id}#decision`, createdAt: at,
      } });
    }
  }
  // a report decided since its entry was filed: nobody needs to answer it any more
  db.prepare("UPDATE entries SET level = 'none' WHERE level = 'manager' AND ref IN (SELECT id FROM docs WHERE type = 'report' AND decision IS NOT NULL AND decision != 'pending')").run();

  // one entry per grant history line: the proposal, the humans' decisions, the gate, the close
  for (const g of grants.values()) {
    const job = jobFor({ buildingId: g.buildingId, rule: "ceiling", pocketRef: g.id });
    if (!job) continue;
    g.history.forEach((h, i) => {
      const ref = `${g.id}#h${i}`;
      if (known.has(ref)) return;
      const moved: EntryMoved = { action: h.action, ...(h.tokens != null ? { actionTokens: h.tokens } : {}) };
      pending.push({ id: newId("en"), jobId: job.id, at: h.at, entry: {
        authorKind: h.byKind === "user" ? (h.byId === "system" ? "code" : "human") : authorKindOf(world, h.byId, managers), authorId: h.byId === "system" ? null : h.byId,
        assignmentId: null, sessionId: null, pocket: g.id, tokens: 0, moved, proposes: null, answers: null, level: "none",
        note: h.note ? `${h.action}: ${h.note}` : h.action, body: "", ref, createdAt: h.at,
      } });
    });
  }

  // seq: after the job's last entry, in time order
  pending.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
  const nextSeq = new Map<string, number>();
  const maxSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM entries WHERE jobId = ?");
  for (const p of pending) {
    const seq = (nextSeq.get(p.jobId) ?? (maxSeq.get(p.jobId) as { n: number }).n) + 1;
    nextSeq.set(p.jobId, seq);
    world.entries.upsert({ ...p.entry, id: p.id, jobId: p.jobId, seq });
  }
  return { jobs: addedJobs, entries: pending.length };
}

const lastSync = new WeakMap<World, number>();
/** syncJobs, at most once a minute (GET /api/jobs/:id: a grant proposed since boot has its job when it is read). */
function syncSoon(world: World): void {
  const t = Date.now();
  if ((lastSync.get(world) ?? 0) > t - 60_000) return;
  lastSync.set(world, t);
  try { syncJobs(world); } catch (err) { console.error("[core] jobs back-fill failed", err); }
}

/**
 * GET /api/jobs/:id: the job and its thread, oldest entry first. `id` is a job id or its pocketRef (a grant, a
 * schedule, a building id, a human source); a pocketRef shared by several buildings' pocket jobs reads the oldest.
 * A draft grant's job is not found, as the grant itself is not.
 */
export function jobThread(world: World, id: string): { job: Job; entries: Entry[] } {
  syncSoon(world);
  const job = world.jobs.get(id) ?? world.jobs.where("pocketRef = ?", [id], "ORDER BY rule = 'building' DESC, createdAt LIMIT 1")[0];
  if (!job || (job.rule === "ceiling" && world.grants.get(job.pocketRef)?.status === "draft")) throw new AppError("not_found", `job not found: ${id}`);
  return { job, entries: world.entries.where("jobId = ?", [job.id], "ORDER BY seq") };
}
