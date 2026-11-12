/**
 * Jobs and entries (plan dc_uwx045472m steps 3-4; grant gr_9mp6v6vv8k steps 1-2). A job is one piece of work with one
 * budget rule: a grant (`ceiling`), a retainer (`per-run`), an exploration chain (`chunk`), a human's directed source in a
 * building (`pocket`), and each building's own thread (`building`). Its record is a thread of entries: one per session
 * report, plus the answers to it (a manager's review, a human's grant or retainer decision).
 *
 * Written live: `createAssignment` opens its job (`openJob`), a grant's events sync its job (a proposal is a `proposed`
 * ceiling job), and `submit_report` appends the session's entry (`fileReportEntry`, with what it moved). `backfillJobs`
 * still derives both from today's objects at boot, idempotently (ids are deterministic, a job's row follows its object,
 * an entry already in a thread keeps its seq and new ones are appended), and `jobThread` re-syncs the job it reads.
 */
import type { Assignment, Session } from "@muster-town/schema";
import { sessionTokens } from "./bank.ts";
import type { World } from "./world.ts";

type JobRule = "chunk" | "ceiling" | "per-run" | "pocket" | "building";
type JobStatus = "proposed" | "countered" | "open" | "held" | "closed";
type EntryAuthorKind = "fork" | "manager" | "human" | "secretary" | "code";

interface Job {
  id: string; buildingId: string; goalId: string | null; title: string; status: JobStatus; closedAs: string | null;
  rule: JobRule; pocketRef: string | null; createdBy: string; createdAt: string;
}
interface Entry {
  id: string; jobId: string; seq: number; authorKind: EntryAuthorKind; authorId: string; assignmentId: string | null; sessionId: string | null;
  pocket: string | null; tokens: number; moved: Record<string, unknown>; proposes: string | null; answers: string | null;
  level: "code" | "manager" | "human" | "none"; note: string; body: string; docId: string | null; createdAt: string;
}
type EntryRow = Omit<Entry, "seq">;

/**
 * The job an assignment's work belongs to, as SQL over `assignments a` (its id). One rule for the back-fill and the reader:
 * a grant id → that grant's job; a retainer run → its schedule's; exploration → its chain's; directed with a human source →
 * that source's in the building; anything else → the building's own job.
 */
const JOB_OF_ASSIGNMENT = `CASE
  WHEN a.grantId IS NOT NULL THEN 'jb_' || a.grantId
  WHEN a.lane = 'retainer' AND a.sourceId LIKE 'sc\\_%' ESCAPE '\\' THEN 'jb_' || a.sourceId
  WHEN a.lane = 'exploration' THEN 'jb_' || COALESCE(a.chainId, a.id)
  WHEN a.lane = 'directed' AND a.sourceId IS NOT NULL THEN 'jb_' || a.buildingId || '_' || a.sourceId
  ELSE 'jb_' || a.buildingId END`;

/**
 * `JOB_OF_ASSIGNMENT` without the database: the job id, budget rule and pocket of an assignment (also one not stored yet).
 * The rule replaces the lane (`ruleBlock` in lanes.ts keys its checks by it); a test holds the two in step.
 */
export function jobOf(a: Pick<Assignment, "id" | "buildingId" | "lane" | "grantId" | "sourceId" | "chainId" | "reservationId">): { id: string; rule: JobRule; pocketRef: string | null } {
  if (a.grantId) return { id: `jb_${a.grantId}`, rule: "ceiling", pocketRef: a.grantId };
  if (a.lane === "retainer" && a.sourceId?.startsWith("sc_")) return { id: `jb_${a.sourceId}`, rule: "per-run", pocketRef: a.sourceId };
  if (a.lane === "exploration") return { id: `jb_${a.chainId ?? a.id}`, rule: "chunk", pocketRef: a.reservationId ?? null };
  if (a.lane === "directed" && a.sourceId) return { id: `jb_${a.buildingId}_${a.sourceId}`, rule: "pocket", pocketRef: a.sourceId };
  return { id: `jb_${a.buildingId}`, rule: "building", pocketRef: null };
}

/** A report doc's job: its assignment's, else (a rollup, a town-written in-tray row, a manager's own report) its building's. */
const JOB_OF_REPORT = `CASE WHEN a.id IS NULL THEN 'jb_' || d.buildingId ELSE ${JOB_OF_ASSIGNMENT} END`;

const GRANT_STATUS: Record<string, JobStatus> = { proposed: "proposed", countered: "countered", funded: "open", checkpoint: "held", stopping: "open", closed: "closed", rejected: "closed" };
/** A grant's outcome as the job's closedAs: met, spent and done all mean the work ended as planned. */
const GRANT_CLOSED_AS: Record<string, string> = { met: "done", spent: "done", done: "done", cut: "cut", stopped: "stopped" };
const RETAINER_STATUS: Record<string, JobStatus> = { asked: "proposed", countered: "countered", funded: "open", rejected: "closed", ended: "closed" };
const OPEN_ASSIGNMENT = "('pending', 'active')";

function jobRows(world: World, only?: string): Job[] {
  const db = world.db;
  const jobs: Job[] = [];
  const want = (id: string) => !only || only === id;
  const goalOf = new Map((db.prepare("SELECT id, goalId FROM buildings").all() as { id: string; goalId: string | null }[]).map((b) => [b.id, b.goalId]));

  for (const b of db.prepare("SELECT id, name, goalId, createdBy, createdAt FROM buildings").all() as { id: string; name: string; goalId: string | null; createdBy: string | null; createdAt: string }[]) {
    const id = `jb_${b.id}`;
    if (want(id)) jobs.push({ id, buildingId: b.id, goalId: b.goalId, title: b.name, status: "open", closedAs: null, rule: "building", pocketRef: null, createdBy: b.createdBy ?? "system", createdAt: b.createdAt });
  }
  for (const g of db.prepare("SELECT id, buildingId, goalId, title, objective, status, outcome, proposedBy, createdAt FROM grants WHERE status <> 'draft'").all() as { id: string; buildingId: string; goalId: string | null; title: string; objective: string; status: string; outcome: string | null; proposedBy: string; createdAt: string }[]) {
    const id = `jb_${g.id}`;
    if (!want(id)) continue;
    const status = GRANT_STATUS[g.status] ?? "open";
    const closedAs = g.status === "rejected" ? "rejected" : status === "closed" ? GRANT_CLOSED_AS[g.outcome ?? ""] ?? "done" : null;
    jobs.push({ id, buildingId: g.buildingId, goalId: g.goalId ?? goalOf.get(g.buildingId) ?? null, title: g.title || g.objective, status, closedAs, rule: "ceiling", pocketRef: g.id, createdBy: g.proposedBy, createdAt: g.createdAt });
  }
  for (const s of db.prepare("SELECT id, buildingId, title, status, retainer, createdBy, createdAt FROM schedules WHERE lane = 'retainer' OR tokensPerRun > 0").all() as { id: string; buildingId: string; title: string; status: string; retainer: string; createdBy: string; createdAt: string }[]) {
    const id = `jb_${s.id}`;
    if (!want(id)) continue;
    const status = s.status === "ended" ? "closed" : RETAINER_STATUS[s.retainer] ?? "open";
    jobs.push({ id, buildingId: s.buildingId, goalId: goalOf.get(s.buildingId) ?? null, title: s.title, status, closedAs: status !== "closed" ? null : s.retainer === "rejected" ? "rejected" : "done", rule: "per-run", pocketRef: s.id, createdBy: s.createdBy, createdAt: s.createdAt });
  }
  // an exploration chain: one job per chain, open while any of its assignments is; closed with a proposal or with nothing found
  const chunks = db.prepare(`SELECT COALESCE(a.chainId, a.id) AS chain, MIN(a.createdAt) AS createdAt,
      (SELECT f.buildingId FROM assignments f WHERE f.id = COALESCE(a.chainId, a.id)) AS firstBuilding,
      MIN(a.buildingId) AS buildingId, MIN(a.title) AS anyTitle,
      (SELECT f.title FROM assignments f WHERE f.id = COALESCE(a.chainId, a.id)) AS firstTitle,
      (SELECT f.createdBy FROM assignments f WHERE f.id = COALESCE(a.chainId, a.id)) AS firstBy,
      MAX(a.reservationId) AS reservationId, SUM(a.status IN ${OPEN_ASSIGNMENT}) AS open
    FROM assignments a WHERE a.lane = 'exploration' AND a.grantId IS NULL GROUP BY chain`).all() as { chain: string; createdAt: string; firstBuilding: string | null; buildingId: string; anyTitle: string; firstTitle: string | null; firstBy: string | null; reservationId: string | null; open: number }[];
  const proposedBy = db.prepare("SELECT json_extract(payload, '$.grantId') AS grantId FROM events WHERE type = 'exploration.proposed' AND json_extract(payload, '$.assignmentId') IN (SELECT id FROM assignments WHERE COALESCE(chainId, id) = ?) LIMIT 1");
  for (const c of chunks) {
    const id = `jb_${c.chain}`;
    if (!want(id)) continue;
    const closed = !c.open;
    const proposed = closed ? (proposedBy.get(c.chain) as { grantId: string | null } | undefined)?.grantId ?? null : null;
    const buildingId = c.firstBuilding ?? c.buildingId;
    jobs.push({ id, buildingId, goalId: goalOf.get(buildingId) ?? null, title: c.firstTitle ?? c.anyTitle, status: closed ? "closed" : "open", closedAs: closed ? (proposed ? "done" : "nothing-found") : null, rule: "chunk", pocketRef: c.reservationId, createdBy: c.firstBy ?? "system", createdAt: c.createdAt });
  }
  // a human's directed source in a building (a meeting, a tell, a flag): open while any of its assignments is
  const pockets = db.prepare(`SELECT a.buildingId, a.sourceId, MIN(a.createdAt) AS createdAt, MIN(a.createdBy) AS createdBy, SUM(a.status IN ${OPEN_ASSIGNMENT}) AS open,
      (SELECT title FROM meetings WHERE id = a.sourceId) AS meetingTitle, (SELECT title FROM docs WHERE id = a.sourceId) AS docTitle
    FROM assignments a WHERE a.lane = 'directed' AND a.sourceId IS NOT NULL AND a.grantId IS NULL GROUP BY a.buildingId, a.sourceId`).all() as { buildingId: string; sourceId: string; createdAt: string; createdBy: string; open: number; meetingTitle: string | null; docTitle: string | null }[];
  for (const p of pockets) {
    const id = `jb_${p.buildingId}_${p.sourceId}`;
    if (!want(id)) continue;
    jobs.push({ id, buildingId: p.buildingId, goalId: goalOf.get(p.buildingId) ?? null, title: p.meetingTitle ?? p.docTitle ?? `Asked in ${p.sourceId}`, status: p.open ? "open" : "closed", closedAs: p.open ? null : "done", rule: "pocket", pocketRef: p.sourceId, createdBy: p.createdBy, createdAt: p.createdAt });
  }
  return jobs;
}

const authorOfDoc = (authorId: string, authorKind: string, managerId: string | null): EntryAuthorKind =>
  authorId === "system" ? "code" : authorKind === "user" ? "human" : authorId === managerId ? "manager" : "fork";
/**
 * Who answers a report's entry (answer.ts): the code when the town settled it (decided by "system": a step queued, a
 * park, a meeting decision superseding it), the humans for a rollup or a visitor's report, else the manager.
 */
const reportLevel = (r: { decision: string | null; decidedBy: string | null; townHall: number }): Entry["level"] =>
  r.decision && r.decision !== "pending" && r.decidedBy === "system" ? "code" : r.townHall ? "human" : "manager";
const authorOfDecider = (id: string | null | undefined): EntryAuthorKind => (!id || id === "system" ? "code" : id.startsWith("us_") ? "human" : "manager");

/** Every entry the town's records give a job (or every job when `only` is left out), by job id, not yet ordered. */
function entryRows(world: World, only?: string): Map<string, EntryRow[]> {
  const db = world.db;
  const out = new Map<string, EntryRow[]>();
  const add = (e: EntryRow) => { const l = out.get(e.jobId); if (l) l.push(e); else out.set(e.jobId, [e]); };
  const filter = only ? "WHERE job = ?" : "";
  const args = only ? [only] : [];
  const pocketOf = new Map((db.prepare("SELECT id, pocketRef FROM jobs").all() as { id: string; pocketRef: string | null }[]).map((j) => [j.id, j.pocketRef]));

  // a session report: one entry, answered (level manager) once a decision exists
  const reports = db.prepare(`SELECT * FROM (SELECT d.id, d.title, CASE WHEN EXISTS (SELECT 1 FROM entries WHERE id = 'en_' || d.id) THEN '' ELSE d.body END AS body, d.authorId, d.authorKind, d.verdict, d.decision, d.decidedBy, d.createdAt, d.assignmentId,
      CASE WHEN d.tags LIKE '%"rollup"%' OR d.tags LIKE '%"visitor"%' THEN 1 ELSE 0 END AS townHall,
      b.managerAgentId, ${JOB_OF_REPORT} AS job,
      a.grantStep AS step
    FROM docs d LEFT JOIN assignments a ON a.id = d.assignmentId LEFT JOIN buildings b ON b.id = d.buildingId
    WHERE d.type = 'report' AND d.state <> 'draft' AND d.buildingId IS NOT NULL) ${filter}`).all(...args) as { id: string; title: string; body: string; authorId: string; authorKind: string; verdict: string | null; decision: string | null; decidedBy: string | null; townHall: number; createdAt: string; assignmentId: string | null; step: number | null; managerAgentId: string | null; job: string }[];
  // what the Bank booked for each report's sessions (adjusted output tokens) and its last session
  const booked = new Map<string, { tokens: number; sessionId: string; startedAt: string }>();
  for (const se of world.sessions.where("reportId IN (SELECT value FROM json_each(?))", [JSON.stringify(reports.map((r) => r.id))])) {
    const b = booked.get(se.reportId!);
    const tokens = (b?.tokens ?? 0) + sessionTokens(se);
    booked.set(se.reportId!, !b || se.startedAt >= b.startedAt ? { tokens, sessionId: se.id, startedAt: se.startedAt } : { ...b, tokens });
  }
  const reportJob = new Map<string, string>();
  for (const r of reports) {
    reportJob.set(r.id, r.job);
    add({
      id: `en_${r.id}`, jobId: r.job, authorKind: authorOfDoc(r.authorId, r.authorKind, r.managerAgentId), authorId: r.authorId, assignmentId: r.assignmentId, sessionId: booked.get(r.id)?.sessionId ?? null,
      pocket: pocketOf.get(r.job) ?? null, tokens: booked.get(r.id)?.tokens ?? 0, moved: r.step !== null ? { stepsDone: [r.step] } : {}, proposes: r.verdict, answers: null,
      level: reportLevel(r), note: r.title, body: r.body, docId: r.id, createdAt: r.createdAt,
    });
  }
  // the decision on a report: an answer entry on the report's job
  const decisions = db.prepare("SELECT id, ts, text, json_extract(payload, '$.docId') AS docId, json_extract(payload, '$.decision') AS decision, json_extract(payload, '$.note') AS note, json_extract(payload, '$.decidedBy') AS decidedBy FROM events WHERE type = 'doc.decision'").all() as { id: number; ts: string; text: string; docId: string | null; decision: string | null; note: string | null; decidedBy: string | null }[];
  for (const d of decisions) {
    const job = d.docId ? reportJob.get(d.docId) : undefined;
    if (!job) continue;
    add({
      id: `en_ev${d.id}`, jobId: job, authorKind: authorOfDecider(d.decidedBy), authorId: d.decidedBy ?? "system", assignmentId: null, sessionId: null, pocket: null, tokens: 0,
      moved: { decision: d.decision }, proposes: null, answers: `en_${d.docId}`, level: "none", note: d.note ?? "", body: d.text, docId: d.docId, createdAt: d.ts,
    });
  }
  // a grant's history: propose, counter, fund, checkpoint, continue, adjust, cut, close… each an entry on its job
  const grants = db.prepare(`SELECT id, history FROM grants WHERE status <> 'draft'${only ? " AND 'jb_' || id = ?" : ""}`).all(...args) as { id: string; history: string }[];
  for (const g of grants) {
    const history = JSON.parse(g.history || "[]") as { at: string; byId: string; byKind: string; action: string; tokens: number | null; note: string }[];
    history.forEach((h, i) => add({
      id: `en_${g.id}_h${i}`, jobId: `jb_${g.id}`, authorKind: h.action === "checkpoint" || h.byId === "system" ? "code" : h.byKind === "user" ? "human" : "manager", authorId: h.byId,
      assignmentId: null, sessionId: null, pocket: g.id, tokens: 0, moved: { action: h.action, ...(h.tokens !== null && h.tokens !== undefined ? { tokens: h.tokens } : {}) },
      proposes: null, answers: null, level: "none", note: h.note ?? "", body: "", docId: null, createdAt: h.at,
    }));
  }
  // a retainer's decision: approve, counter, reject
  const retainers = db.prepare(`SELECT id, ts, agentId, text, json_extract(payload, '$.scheduleId') AS scheduleId, json_extract(payload, '$.action') AS action FROM events WHERE type = 'retainer.decided'${only ? " AND 'jb_' || json_extract(payload, '$.scheduleId') = ?" : ""}`).all(...args) as { id: number; ts: string; agentId: string | null; text: string; scheduleId: string; action: string }[];
  for (const r of retainers) add({
    id: `en_ev${r.id}`, jobId: `jb_${r.scheduleId}`, authorKind: "human", authorId: r.agentId ?? "system", assignmentId: null, sessionId: null, pocket: r.scheduleId, tokens: 0,
    moved: { action: r.action }, proposes: null, answers: null, level: "none", note: "", body: r.text, docId: null, createdAt: r.ts,
  });
  return out;
}

/** Write the jobs (one, or all) and append the entries their threads don't hold yet, oldest first. Idempotent. */
function sync(world: World, only?: string): { jobs: number; entries: number } {
  const db = world.db;
  let added = 0;
  const jobs = jobRows(world, only);
  db.transaction(() => {
    const upsert = db.prepare(`INSERT INTO jobs (id, buildingId, goalId, title, status, closedAs, rule, pocketRef, createdBy, createdAt)
      VALUES (@id, @buildingId, @goalId, @title, @status, @closedAs, @rule, @pocketRef, @createdBy, @createdAt)
      ON CONFLICT(id) DO UPDATE SET buildingId = excluded.buildingId, goalId = excluded.goalId, title = excluded.title, status = excluded.status, closedAs = excluded.closedAs, pocketRef = excluded.pocketRef`);
    for (const j of jobs) upsert.run(j);
    const known = new Set(jobs.map((j) => j.id));
    const have = db.prepare("SELECT 1 FROM entries WHERE id = ?");
    const maxSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM entries WHERE jobId = ?");
    const insert = db.prepare(`INSERT INTO entries (id, jobId, seq, authorKind, authorId, assignmentId, sessionId, pocket, tokens, moved, proposes, answers, level, note, body, docId, createdAt)
      VALUES (@id, @jobId, @seq, @authorKind, @authorId, @assignmentId, @sessionId, @pocket, @tokens, @moved, @proposes, @answers, @level, @note, @body, @docId, @createdAt)`);
    // an entry written live keeps its moved and the level its answer gave it (answer.ts); a back-filled one follows the
    // decision; its tokens follow what the Bank booked since
    const refresh = db.prepare("UPDATE entries SET level = CASE WHEN level = 'none' OR (level = 'manager' AND @level = 'code') THEN @level ELSE level END, tokens = MAX(tokens, @tokens) WHERE id = @id AND ((level <> @level AND (level = 'none' OR (level = 'manager' AND @level = 'code'))) OR tokens < @tokens)");
    for (const [jobId, rows] of entryRows(world, only)) {
      if (!known.has(jobId) && !db.prepare("SELECT 1 FROM jobs WHERE id = ?").get(jobId)) continue;
      let seq = (maxSeq.get(jobId) as { n: number }).n;
      // answers sort after what they answer when stamped in the same millisecond
      rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || Number(!!a.answers) - Number(!!b.answers) || a.id.localeCompare(b.id));
      for (const e of rows) {
        if (have.get(e.id)) { refresh.run({ id: e.id, level: e.level, tokens: e.tokens }); continue; }
        insert.run({ ...e, seq: ++seq, moved: JSON.stringify(e.moved) });
        added++;
      }
    }
  })();
  return { jobs: jobs.length, entries: added };
}

/** Write one job's row (and append what its thread lacks): a grant's event, a new assignment's job. No-op for an unknown id. */
export function syncJob(world: World, jobId: string): void {
  sync(world, jobId);
}

/** A new assignment's job: picked when it exists, else created (a chunk for a new explorer, a pocket for a new source). */
export function openJob(world: World, a: Assignment): string {
  const { id } = jobOf(a);
  if (!world.db.prepare("SELECT 1 FROM jobs WHERE id = ? AND status <> 'closed'").get(id)) {
    const row = jobRows(world, id)[0];
    if (row) world.db.prepare(`INSERT INTO jobs (id, buildingId, goalId, title, status, closedAs, rule, pocketRef, createdBy, createdAt)
      VALUES (@id, @buildingId, @goalId, @title, @status, @closedAs, @rule, @pocketRef, @createdBy, @createdAt)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, closedAs = excluded.closedAs, pocketRef = excluded.pocketRef, title = excluded.title`).run(row);
  }
  return id;
}

/** What a session's report moved (the entry's `moved`): steps done, key results claimed, what is left, a top-up, a proposal. */
interface ReportMoved {
  stepsDone?: number[]; krClaimed?: { id: string; status: string; evidence: string }[]; left?: string;
  topUp?: { tokens: number; buys: string }; proposed?: string;
}

/**
 * `submit_report`'s entry (plan step 4): one per report, on its assignment's job (else the building's), id `en_<report>`
 * so the back-fill never writes it twice. Its job's row is re-read after, so a chunk whose last session reported closes.
 */
export function fileReportEntry(world: World, r: { docId: string; buildingId: string; title: string; body: string; verdict: string; authorId: string; manager: boolean; assignment: Assignment | null; session: Session | null; moved: ReportMoved }): string {
  const db = world.db;
  const jobId = r.assignment ? openJob(world, r.assignment) : `jb_${r.buildingId}`;
  if (!db.prepare("SELECT 1 FROM jobs WHERE id = ?").get(jobId)) sync(world, jobId);
  const seq = (db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM entries WHERE jobId = ?").get(jobId) as { n: number }).n + 1;
  const moved = Object.fromEntries(Object.entries(r.moved).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length)));
  const pocket = (db.prepare("SELECT pocketRef FROM jobs WHERE id = ?").get(jobId) as { pocketRef: string | null } | undefined)?.pocketRef ?? null;
  db.prepare(`INSERT OR IGNORE INTO entries (id, jobId, seq, authorKind, authorId, assignmentId, sessionId, pocket, tokens, moved, proposes, answers, level, note, body, docId, createdAt)
    VALUES (@id, @jobId, @seq, @authorKind, @authorId, @assignmentId, @sessionId, @pocket, @tokens, @moved, @proposes, NULL, 'none', @note, @body, @docId, @createdAt)`).run({
    id: `en_${r.docId}`, jobId, seq, authorKind: r.manager ? "manager" : "fork", authorId: r.authorId, assignmentId: r.assignment?.id ?? null, sessionId: r.session?.id ?? null,
    pocket, tokens: r.session ? sessionTokens(r.session) : 0, moved: JSON.stringify(moved), proposes: r.verdict, note: r.title, body: r.body, docId: r.docId,
    createdAt: world.docs.require(r.docId, "doc").createdAt,
  });
  return jobId;
}

/** Re-read a job's row from its object (a chunk closes when its last assignment is done). */
export function refreshJob(world: World, jobId: string): void {
  const row = jobRows(world, jobId)[0];
  if (row) world.db.prepare("UPDATE jobs SET status = @status, closedAs = @closedAs, pocketRef = @pocketRef, title = @title WHERE id = @id").run(row);
}

/** Boot: back-fill every job and its thread from grants, retainers, exploration chains, directed sources and buildings. */
export function backfillJobs(world: World): { jobs: number; entries: number } {
  return sync(world);
}

/**
 * The job an id names: a job id (jb_…), or the id of what it tracks (a grant, a schedule, a building, an exploration
 * chain's first assignment, any assignment: its job). Null when none.
 */
function resolveJobId(world: World, id: string): string | null {
  const db = world.db;
  const exists = (j: string) => !!db.prepare("SELECT 1 FROM jobs WHERE id = ?").get(j);
  if (id.startsWith("jb_")) return id;
  // a grant, schedule, building or chain made since the last sync has no row yet: its job is still `jb_<id>`
  if (exists(`jb_${id}`) || jobRows(world, `jb_${id}`).length) return `jb_${id}`;
  const a = db.prepare(`SELECT ${JOB_OF_ASSIGNMENT} AS job FROM assignments a WHERE a.id = ?`).get(id) as { job: string } | undefined;
  if (a) return a.job;
  const byPocket = db.prepare("SELECT id FROM jobs WHERE pocketRef = ? ORDER BY createdAt LIMIT 1").get(id) as { id: string } | undefined;
  return byPocket?.id ?? null;
}

const toJob = (r: Record<string, unknown>): Job => r as unknown as Job;
const toEntry = (r: Record<string, unknown>): Entry => ({ ...(r as unknown as Entry), moved: JSON.parse(String(r.moved ?? "{}")) as Record<string, unknown> });

/**
 * One job and its thread (GET /api/jobs/:id), re-synced from today's records first. `from`: entries with seq ≥ it (default
 * the last `limit`, at most 200). Null when the id names no job.
 */
export function jobThread(world: World, id: string, opts: { from?: number; limit?: number } = {}): { job: Job; entries: Entry[]; total: number } | null {
  const jobId = resolveJobId(world, id);
  if (!jobId) return null;
  sync(world, jobId);
  const row = world.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 200);
  const total = (world.db.prepare("SELECT COUNT(*) AS n FROM entries WHERE jobId = ?").get(jobId) as { n: number }).n;
  const rows = opts.from !== undefined
    ? world.db.prepare("SELECT * FROM entries WHERE jobId = ? AND seq >= ? ORDER BY seq LIMIT ?").all(jobId, opts.from, limit)
    : world.db.prepare("SELECT * FROM (SELECT * FROM entries WHERE jobId = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq").all(jobId, limit);
  return { job: toJob(row), entries: (rows as Record<string, unknown>[]).map(toEntry), total };
}
