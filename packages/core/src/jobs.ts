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
import type { Assignment, Doc, Session } from "@muster-town/schema";
import { answer, type EntryLevel, type JobRule } from "./answer.ts";
import { sessionTokens } from "./bank.ts";
import { newId, nowIso } from "./util.ts";
import type { World } from "./world.ts";

type JobStatus = "proposed" | "countered" | "open" | "held" | "closed";
type EntryAuthorKind = "fork" | "manager" | "human" | "secretary" | "code";

interface Job {
  id: string; buildingId: string; goalId: string | null; title: string; status: JobStatus; closedAs: string | null;
  rule: JobRule; pocketRef: string | null; createdBy: string; createdAt: string;
}
export interface Entry {
  id: string; jobId: string; seq: number; authorKind: EntryAuthorKind; authorId: string; assignmentId: string | null; sessionId: string | null;
  pocket: string | null; tokens: number; moved: Record<string, unknown>; proposes: string | null; answers: string | null;
  /** who owes it an answer (answer.ts): `code` = settled by code, `none` = a record. It is answered once an entry `answers` it. */
  level: EntryLevel; note: string; body: string; docId: string | null; createdAt: string;
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
  // a human's flag (plan step 5): its own pocket job from the moment it is planted, open until it is decided and its work ended
  const flags = db.prepare(`SELECT d.id, d.buildingId, d.title, d.authorId, d.createdAt, d.decision,
      (SELECT COUNT(*) FROM assignments a WHERE a.buildingId = d.buildingId AND a.sourceId = d.id AND a.status IN ${OPEN_ASSIGNMENT}) AS open
    FROM docs d WHERE d.type = 'flag' AND d.buildingId IS NOT NULL`).all() as { id: string; buildingId: string; title: string; authorId: string; createdAt: string; decision: string | null; open: number }[];
  const flagJobs = new Set<string>();
  for (const f of flags) {
    const id = flagJobId(f.buildingId, f.id);
    flagJobs.add(id);
    if (!want(id)) continue;
    const open = f.decision === "pending" || f.open > 0;
    jobs.push({ id, buildingId: f.buildingId, goalId: goalOf.get(f.buildingId) ?? null, title: f.title, status: open ? "open" : "closed", closedAs: open ? null : "done", rule: "pocket", pocketRef: f.id, createdBy: f.authorId, createdAt: f.createdAt });
  }
  // a human's directed source in a building (a meeting, a tell, a flag): open while any of its assignments is
  const pockets = db.prepare(`SELECT a.buildingId, a.sourceId, MIN(a.createdAt) AS createdAt, MIN(a.createdBy) AS createdBy, SUM(a.status IN ${OPEN_ASSIGNMENT}) AS open,
      (SELECT title FROM meetings WHERE id = a.sourceId) AS meetingTitle, (SELECT title FROM docs WHERE id = a.sourceId) AS docTitle
    FROM assignments a WHERE a.lane = 'directed' AND a.sourceId IS NOT NULL AND a.grantId IS NULL GROUP BY a.buildingId, a.sourceId`).all() as { buildingId: string; sourceId: string; createdAt: string; createdBy: string; open: number; meetingTitle: string | null; docTitle: string | null }[];
  for (const p of pockets) {
    const id = `jb_${p.buildingId}_${p.sourceId}`;
    if (!want(id) || flagJobs.has(id)) continue;
    jobs.push({ id, buildingId: p.buildingId, goalId: goalOf.get(p.buildingId) ?? null, title: p.meetingTitle ?? p.docTitle ?? `Asked in ${p.sourceId}`, status: p.open ? "open" : "closed", closedAs: p.open ? null : "done", rule: "pocket", pocketRef: p.sourceId, createdBy: p.createdBy, createdAt: p.createdAt });
  }
  return jobs;
}

const authorOfDoc = (authorId: string, authorKind: string, managerId: string | null): EntryAuthorKind =>
  authorId === "system" ? "code" : authorKind === "user" ? "human" : authorId === managerId ? "manager" : "fork";
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
  const reports = db.prepare(`SELECT * FROM (SELECT d.id, d.title, CASE WHEN EXISTS (SELECT 1 FROM entries WHERE id = 'en_' || d.id) THEN '' ELSE d.body END AS body, d.authorId, d.authorKind, d.verdict, d.decision, d.createdAt, d.assignmentId,
      b.managerAgentId, ${JOB_OF_REPORT} AS job, d.tags, b.kind AS buildingKind,
      a.grantStep AS step
    FROM docs d LEFT JOIN assignments a ON a.id = d.assignmentId LEFT JOIN buildings b ON b.id = d.buildingId
    WHERE d.type = 'report' AND d.state <> 'draft' AND d.buildingId IS NOT NULL) ${filter}`).all(...args) as { id: string; title: string; body: string; authorId: string; authorKind: string; verdict: string | null; decision: string | null; createdAt: string; assignmentId: string | null; step: number | null; managerAgentId: string | null; job: string; tags: string; buildingKind: string | null }[];
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
      level: reportForHumans(r.tags, r.buildingKind) ? "human" : "manager", note: r.title, body: r.body, docId: r.id, createdAt: r.createdAt,
    });
  }
  // a flag: the human's entry that opens its pocket job; the manager delegates it
  const flags = db.prepare(`SELECT * FROM (SELECT d.id, d.title, d.body, d.authorId, d.createdAt, 'jb_' || d.buildingId || '_' || d.id AS job FROM docs d WHERE d.type = 'flag' AND d.buildingId IS NOT NULL) ${filter}`).all(...args) as { id: string; title: string; body: string; authorId: string; createdAt: string; job: string }[];
  for (const f of flags) {
    reportJob.set(f.id, f.job);
    add({ id: `en_${f.id}`, jobId: f.job, authorKind: "human", authorId: f.authorId, assignmentId: null, sessionId: null, pocket: f.id, tokens: 0, moved: { kind: "flag" }, proposes: null, answers: null, level: "manager", note: f.title, body: f.body, docId: f.id, createdAt: f.createdAt });
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
      assignmentId: null, sessionId: null, pocket: g.id, tokens: 0, moved: { kind: "decision", action: h.action, ...(h.tokens !== null && h.tokens !== undefined ? { tokens: h.tokens } : {}) },
      proposes: null, answers: null, level: h.byKind === "user" ? answer({ kind: "decision", action: h.action }).level : "none", note: h.note ?? "", body: "", docId: null, createdAt: h.at,
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
  // one job synced as its object changed is live; the boot back-fill of every job announces nothing
  const live = !!only;
  const buildingOf = new Map(jobs.map((j) => [j.id, j.buildingId]));
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
    // an entry written live keeps its moved and its level (answer.ts set it); its tokens follow what the Bank booked since
    const refresh = db.prepare("UPDATE entries SET tokens = MAX(tokens, @tokens) WHERE id = @id AND tokens < @tokens");
    for (const [jobId, rows] of entryRows(world, only)) {
      if (!known.has(jobId) && !db.prepare("SELECT 1 FROM jobs WHERE id = ?").get(jobId)) continue;
      let seq = (maxSeq.get(jobId) as { n: number }).n;
      // answers sort after what they answer when stamped in the same millisecond
      rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || Number(!!a.answers) - Number(!!b.answers) || a.id.localeCompare(b.id));
      for (const e of rows) {
        if (have.get(e.id)) { refresh.run({ id: e.id, tokens: e.tokens }); continue; }
        // history back-filled at boot is a record: an old counter, reject or cut is not put back in a manager's queue
        const level = !live && !e.docId && e.level === "manager" ? "none" : e.level;
        insert.run({ ...e, level, seq: ++seq, moved: JSON.stringify(e.moved) });
        added++;
        // a human's decision the manager must move on (a counter, a reject, a cut): the event wakes its team-lead session
        if (e.level === "manager" && !e.docId && live) world.events.append({ type: "entry.created", agentId: null, buildingId: buildingOf.get(jobId) ?? null, text: `On the thread of ${jobId}: ${String(e.moved.action ?? "entry")} ${e.note.slice(0, 140)}`.trim(), payload: { entryId: e.id, jobId, level: e.level, authorKind: e.authorKind, answers: e.answers, kind: "decision" } });
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
export function fileReportEntry(world: World, r: { docId: string; buildingId: string; title: string; body: string; verdict: string; authorId: string; manager: boolean; assignment: Assignment | null; session: Session | null; moved: ReportMoved; level?: EntryLevel }): string {
  const db = world.db;
  const jobId = r.assignment ? openJob(world, r.assignment) : `jb_${r.buildingId}`;
  if (!db.prepare("SELECT 1 FROM jobs WHERE id = ?").get(jobId)) sync(world, jobId);
  const seq = (db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM entries WHERE jobId = ?").get(jobId) as { n: number }).n + 1;
  const moved = Object.fromEntries(Object.entries(r.moved).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length)));
  const pocket = (db.prepare("SELECT pocketRef FROM jobs WHERE id = ?").get(jobId) as { pocketRef: string | null } | undefined)?.pocketRef ?? null;
  db.prepare(`INSERT OR IGNORE INTO entries (id, jobId, seq, authorKind, authorId, assignmentId, sessionId, pocket, tokens, moved, proposes, answers, level, note, body, docId, createdAt)
    VALUES (@id, @jobId, @seq, @authorKind, @authorId, @assignmentId, @sessionId, @pocket, @tokens, @moved, @proposes, NULL, @level, @note, @body, @docId, @createdAt)`).run({
    level: r.level ?? "manager",
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

// ---- the one loop's shell (plan dc_uwx045472m A2; answer.ts is its pure core) ----

/** A flag's pocket job: its own from the moment it is planted (the work it becomes cites the flag as its source). */
export const flagJobId = (buildingId: string, flagId: string) => `jb_${buildingId}_${flagId}`;

/** A report written for the humans (a manager's rollup, an unhomed visitor's report filed under the Town Hall): as `isTownHallItem`, from the row. */
function reportForHumans(tags: string, buildingKind: string | null): boolean {
  return buildingKind === "town-hall" ? tags.includes('"visitor"') : tags.includes('"rollup"');
}

/** What a new entry needs; the rest is derived (seq, the job's pocket, now). */
interface NewEntry {
  /** deterministic when the back-fill could also write it (en_<doc>, en_ev<event>); else made here */
  id?: string;
  jobId: string; authorKind: EntryAuthorKind; authorId: string; level: EntryLevel; note: string;
  assignmentId?: string | null; sessionId?: string | null; tokens?: number; moved?: Record<string, unknown>;
  proposes?: string | null; answers?: string | null; body?: string; docId?: string | null; createdAt?: string;
}

/** The job's row, written from its object when the table lacks it; false when the id names no job. */
function ensureJob(world: World, jobId: string): boolean {
  const has = () => !!world.db.prepare("SELECT 1 FROM jobs WHERE id = ?").get(jobId);
  if (has()) return true;
  sync(world, jobId);
  return has();
}

/**
 * Append one entry to a job's thread, live. Written once per id (null when the thread already holds it, or the job does
 * not exist). `entry.created` carries its level: one at level manager wakes the building's manager (runtime waker).
 */
export function appendEntry(world: World, e: NewEntry): Entry | null {
  const db = world.db;
  if (!ensureJob(world, e.jobId)) return null;
  const id = e.id ?? newId("en");
  if (db.prepare("SELECT 1 FROM entries WHERE id = ?").get(id)) return null;
  const job = db.prepare("SELECT buildingId, pocketRef FROM jobs WHERE id = ?").get(e.jobId) as { buildingId: string; pocketRef: string | null };
  const seq = (db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM entries WHERE jobId = ?").get(e.jobId) as { n: number }).n + 1;
  db.prepare(`INSERT INTO entries (id, jobId, seq, authorKind, authorId, assignmentId, sessionId, pocket, tokens, moved, proposes, answers, level, note, body, docId, createdAt)
    VALUES (@id, @jobId, @seq, @authorKind, @authorId, @assignmentId, @sessionId, @pocket, @tokens, @moved, @proposes, @answers, @level, @note, @body, @docId, @createdAt)`).run({
    id, jobId: e.jobId, seq, authorKind: e.authorKind, authorId: e.authorId, assignmentId: e.assignmentId ?? null, sessionId: e.sessionId ?? null, pocket: job.pocketRef,
    tokens: Math.round(e.tokens ?? 0), moved: JSON.stringify(e.moved ?? {}), proposes: e.proposes ?? null, answers: e.answers ?? null, level: e.level,
    note: e.note.slice(0, 2000), body: e.body ?? "", docId: e.docId ?? null, createdAt: e.createdAt ?? nowIso(),
  });
  const entry = entryOf(world, id)!;
  // a doc-backed entry's doc.created already tells the feed and wakes the manager; this event is for the ones without a doc
  if (!entry.docId) {
    world.events.append({ type: "entry.created", agentId: null, buildingId: job.buildingId, text: `On the thread of ${e.jobId}: ${entry.note.slice(0, 160) || entry.id}`, payload: { entryId: id, jobId: e.jobId, level: e.level, authorKind: e.authorKind, answers: entry.answers, kind: entry.moved.kind ?? null } });
  }
  return entry;
}

/** What the Bank booked for an entry's session, once it is settled (a dead session's entry is written before its charge). */
export function bookEntryTokens(world: World, entryId: string, tokens: number): void {
  world.db.prepare("UPDATE entries SET tokens = MAX(tokens, ?) WHERE id = ?").run(Math.round(tokens), entryId);
}

/** One entry by id. */
export function entryOf(world: World, id: string): Entry | undefined {
  const row = world.db.prepare("SELECT * FROM entries WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? toEntry(row) : undefined;
}

/** Whether an entry on the thread answers this one. */
export function isAnswered(world: World, entryId: string): boolean {
  return !!world.db.prepare("SELECT 1 FROM entries WHERE answers = ?").get(entryId);
}

/** Who answers, as an entry author: the system is the code, a user a human, an agent the manager (the Secretary by name). */
const answererKind = (world: World, by: { kind: string; id: string }): EntryAuthorKind =>
  by.kind === "system" || by.id === "system" ? "code" : by.kind === "user" ? "human" : world.agents.get(by.id)?.name === "Secretary" ? "secretary" : "manager";

/**
 * Answer an entry: one answer entry on its thread (`answers` = it), a record at level none unless `level` says the answer
 * itself needs someone (a human's answer the manager must move on). Null when the entry is unknown or the answer exists.
 */
export function answerEntry(world: World, entryId: string, by: { kind: string; id: string }, decision: string, note: string, opts: { id?: string; level?: EntryLevel } = {}): Entry | null {
  const e = entryOf(world, entryId);
  if (!e) return null;
  return appendEntry(world, {
    id: opts.id, jobId: e.jobId, authorKind: answererKind(world, by), authorId: by.id, level: opts.level ?? "none",
    // an answer that itself waits for someone (a human's decision the manager moves on) is an item of its own, not its doc's
    note, moved: { decision }, answers: e.id, docId: opts.level && opts.level !== "none" ? null : e.docId,
  });
}

/** Pass an entry up (plan A2: it spawns nothing, it carries a note): its level changes; the answer entry says why. */
export function setEntryLevel(world: World, entryId: string, level: EntryLevel): void {
  world.db.prepare("UPDATE entries SET level = ? WHERE id = ?").run(level, entryId);
}

/** The rule of a job, by id; `building` when the row is missing (a building's own thread). */
function ruleOf(world: World, jobId: string): JobRule {
  return ((world.db.prepare("SELECT rule FROM jobs WHERE id = ?").get(jobId) as { rule: JobRule } | undefined)?.rule) ?? "building";
}

/**
 * The entries of a building's jobs that wait for its manager and have no doc: unanswered, at level manager (a session
 * that died, a human's counter, reject, cut or missed key result, a tell, a mention, an outbox answer). Oldest first.
 * With the building's pending in-tray docs (`intrayOf`: reports and flags the code did not settle) they are the
 * manager's queue: a view over the threads, no document of its own.
 */
export function openManagerEntries(world: World, buildingId: string): Entry[] {
  const rows = world.db.prepare(`SELECT e.* FROM entries e JOIN jobs j ON j.id = e.jobId
    WHERE j.buildingId = ? AND e.level = 'manager' AND e.docId IS NULL AND NOT EXISTS (SELECT 1 FROM entries x WHERE x.answers = e.id)
    ORDER BY e.createdAt, e.rowid`).all(buildingId) as Record<string, unknown>[];
  return rows.map(toEntry);
}

/**
 * A session that ended without a report (plan step 5: no stub doc): one `code` entry on its assignment's job (else the
 * building's), id `en_<session>` so it is written once. Stopped by whoever stopped its agent → a record; otherwise it
 * waits for the manager, who retries, redirects or drops the work with `review`.
 */
export function fileDeadSession(world: World, r: { session: Session; assignment: Assignment | null; buildingId: string; agentName: string; title: string; body: string; stopped: boolean; error: string | null }): Entry | null {
  const jobId = r.assignment ? openJob(world, r.assignment) : `jb_${r.buildingId}`;
  if (!ensureJob(world, jobId)) return null;
  const a = answer({ kind: "dead-session", rule: ruleOf(world, jobId), stopped: r.stopped });
  return appendEntry(world, {
    id: `en_${r.session.id}`, jobId, authorKind: "code", authorId: r.session.agentId, level: a.level, note: r.title, body: r.body,
    assignmentId: r.assignment?.id ?? null, sessionId: r.session.id, tokens: sessionTokens(r.session),
    moved: { kind: "dead-session", stopped: r.stopped, ...(r.error ? { error: r.error.slice(0, 500) } : {}), by: r.agentName },
  });
}
