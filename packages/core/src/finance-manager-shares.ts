import type { Session, TokenCounts } from "@muster-town/schema";
import { sessionTokens } from "./bank.ts";
import type { World } from "./world.ts";

/**
 * What managing each job cost (gr_064fmkq31s step 1, kr_xvnxm4kqwy): every manage session's adjusted tokens, split onto
 * the jobs it worked. Same "decided inside the wake" rule as `managerWakes` (finance-manager-wakes.ts): an act counts in a
 * wake of its agent when its time falls in [startedAt, endedAt] (a running wake: up to now), and each act counts once
 * (the first wake that holds it).
 *
 * An act is one thing the manager decided on a job: a report or flag it decided (the doc's job), an ask it acted on
 * (its history: create, rewrite, fold, retire, withdraw, defer, decide; the job of the entry it was raised on), or an
 * entry it wrote on a thread (a review's answer, an ask filed, a need answered). Acts share a key when they are one thing
 * (a review writes the doc's decision and its answer entry `en_ev…` answering `en_<docId>`: one decision).
 *
 * The split: a manage session with a `meetingId` → `oneOnOnes` (a 1:1 with a human, whatever it decided); else its tokens
 * split equally over the distinct jobs of its acts; a wake with no act → its building's own job as `upkeep`. So
 * Σ jobs + Σ upkeep + oneOnOnes = Σ manage sessions, within rounding (`check`).
 */
type ShareSession = Pick<Session, "id" | "agentId" | "purpose" | "meetingId" | "model" | "bankModel" | "byModel" | "startedAt" | "endedAt"> & Partial<TokenCounts>;
interface ManagerAct {
  agentId: string; at: string; jobId: string;
  /** one decision: acts with the same key (a doc and its answer entry) count once */
  key: string;
}
export interface ManagingLine { tokens: number; wakes: number; decisions: number }
interface ManagerSharesInputs {
  sessions: ShareSession[];
  acts: ManagerAct[];
  /** agent → its building (a wake with no act is its building's upkeep) */
  agents: { id: string; buildingId: string | null }[];
}
export interface ManagerShares {
  /** Σ manage sessions' tokens (what the parts sum to) */
  manageTokens: number; sessions: number;
  /** by job id: the job's share of the wakes that worked it */
  jobs: Record<string, ManagingLine>;
  /** by building id: wakes that decided nothing, booked to the building's own job */
  upkeep: Record<string, { tokens: number; wakes: number }>;
  oneOnOnes: { tokens: number; wakes: number };
  totals: { jobs: number; upkeep: number; oneOnOnes: number };
  /** jobs / manageTokens (0 when there is none) */
  tiedShare: number;
  check: { ok: boolean; diff: number; identity: string };
}

const IDENTITY = "Σ job shares + Σ upkeep + 1:1s = Σ manage sessions";

/** The pure split behind `managing` on a job, a grant and GET /api/finance/spend `managerShares`. `now` ends a running wake. */
export function managerShares(inp: ManagerSharesInputs, now = new Date()): ManagerShares {
  const byAgent = new Map<string, { at: number; jobId: string; key: string }[]>();
  for (const a of inp.acts) {
    const list = byAgent.get(a.agentId) ?? [];
    list.push({ at: Date.parse(a.at), jobId: a.jobId, key: a.key });
    byAgent.set(a.agentId, list);
  }
  const buildingOf = new Map(inp.agents.map((a) => [a.id, a.buildingId]));
  const counted = new Set<string>();
  const jobs = new Map<string, ManagingLine>();
  const upkeep = new Map<string, { tokens: number; wakes: number }>();
  const oneOnOnes = { tokens: 0, wakes: 0 };
  let manageTokens = 0, n = 0, toJobs = 0, toUpkeep = 0;
  // earliest wakes first, so an act shared by two overlapping wakes counts in the first
  const sessions = inp.sessions.filter((s) => s.purpose === "manage").sort((x, y) => x.startedAt.localeCompare(y.startedAt));
  for (const s of sessions) {
    n++;
    const tokens = sessionTokens(s);
    manageTokens += tokens;
    if (s.meetingId) { oneOnOnes.tokens += tokens; oneOnOnes.wakes++; continue; }
    const start = Date.parse(s.startedAt), end = s.endedAt ? Date.parse(s.endedAt) : now.getTime();
    const worked = new Map<string, Set<string>>();
    for (const a of byAgent.get(s.agentId) ?? []) {
      if (a.at < start || a.at > end || counted.has(a.key)) continue;
      counted.add(a.key);
      const keys = worked.get(a.jobId) ?? new Set<string>();
      keys.add(a.key);
      worked.set(a.jobId, keys);
    }
    if (!worked.size) {
      const b = buildingOf.get(s.agentId) ?? "none";
      const u = upkeep.get(b) ?? { tokens: 0, wakes: 0 };
      u.tokens += tokens; u.wakes++;
      upkeep.set(b, u);
      toUpkeep += tokens;
      continue;
    }
    const share = tokens / worked.size;
    for (const [jobId, keys] of worked) {
      const j = jobs.get(jobId) ?? { tokens: 0, wakes: 0, decisions: 0 };
      j.tokens += share; j.wakes++; j.decisions += keys.size;
      jobs.set(jobId, j);
    }
    toJobs += tokens;
  }
  const round = <T extends { tokens: number }>(m: Map<string, T>): Record<string, T> =>
    Object.fromEntries([...m.entries()].sort(([, x], [, y]) => y.tokens - x.tokens).map(([k, v]) => [k, { ...v, tokens: Math.round(v.tokens) }]));
  const out = {
    manageTokens: Math.round(manageTokens), sessions: n,
    jobs: round(jobs), upkeep: round(upkeep), oneOnOnes: { ...oneOnOnes, tokens: Math.round(oneOnOnes.tokens) },
    totals: { jobs: Math.round(toJobs), upkeep: Math.round(toUpkeep), oneOnOnes: Math.round(oneOnOnes.tokens) },
    tiedShare: manageTokens ? Math.round((toJobs / manageTokens) * 10_000) / 10_000 : 0,
  };
  // the rounded job lines against the unrounded sessions: within a token per session
  const parts = Object.values(out.jobs).reduce((x, j) => x + j.tokens, 0) + Object.values(out.upkeep).reduce((x, u) => x + u.tokens, 0) + out.oneOnOnes.tokens;
  const diff = Math.round(parts - manageTokens);
  return { ...out, check: { ok: Math.abs(diff) <= Math.max(1, n), diff, identity: IDENTITY } };
}

/** The ask-history actions that are an agent acting on the ask (the same set as `managerWakes`). */
const ASK_ACTIONS = ["create", "rewritten", "fold", "retire", "withdraw", "defer", "decide"];

/** A report's or flag's job, as SQL over `docs d` joined to `assignments a` (jobs.ts JOB_OF_ASSIGNMENT / JOB_OF_REPORT). */
const JOB_OF_DOC = `CASE
  WHEN a.id IS NULL THEN 'jb_' || COALESCE(d.buildingId, 'none')
  WHEN a.grantId IS NOT NULL THEN 'jb_' || a.grantId
  WHEN a.lane = 'retainer' AND a.sourceId LIKE 'sc\\_%' ESCAPE '\\' THEN 'jb_' || a.sourceId
  WHEN a.lane = 'exploration' THEN 'jb_' || COALESCE(a.chainId, a.id)
  WHEN a.lane = 'directed' AND a.sourceId IS NOT NULL THEN 'jb_' || a.buildingId || '_' || a.sourceId
  ELSE 'jb_' || a.buildingId END`;

/**
 * Every manager act in [from, to] (agents only; `agentIds` narrows), from the docs, asks and entries tables. A review's
 * answer entry (`answers` en_<docId>) shares the doc's key; an entry about an ask (`moved.askId`) shares the ask's.
 */
export function managerActs(world: World, from: string, to: string, opts: { agentIds?: string[]; jobId?: string } = {}): ManagerAct[] {
  const db = world.db;
  const only = opts.agentIds ? JSON.stringify(opts.agentIds) : null;
  const agentFilter = (col: string) => (only ? ` AND ${col} IN (SELECT value FROM json_each(@only))` : "");
  const args = { from, to, ...(only ? { only } : {}), ...(opts.jobId ? { job: opts.jobId } : {}) };
  // one job's acts only (`jobId`): the same rows, filtered on the computed job
  const ofJob = (sql: string) => (opts.jobId ? `SELECT * FROM (${sql}) WHERE jobId = @job` : sql);
  const acts: ManagerAct[] = [];
  const docs = db.prepare(ofJob(`SELECT d.id AS key, d.decidedBy AS agentId, d.decidedAt AS at, ${JOB_OF_DOC} AS jobId
    FROM docs d LEFT JOIN assignments a ON a.id = d.assignmentId
    WHERE d.decidedBy LIKE 'ag\\_%' ESCAPE '\\' AND d.decidedAt >= @from AND d.decidedAt <= @to${agentFilter("d.decidedBy")}`)).all(args) as ManagerAct[];
  acts.push(...docs);
  // an ask's job: the thread of the entry it was raised on (a ask with none is its building's own)
  const asks = db.prepare(ofJob(`SELECT k.id AS askId, h.value ->> '$.by' AS agentId, h.value ->> '$.at' AS at,
      COALESCE(e.jobId, 'jb_' || COALESCE(k.buildingId, 'none')) AS jobId
    FROM asks k, json_each(k.history) h LEFT JOIN entries e ON e.id = k.sourceEntryId
    WHERE k.updatedAt >= @from AND h.value ->> '$.by' LIKE 'ag\\_%' ESCAPE '\\'
      AND h.value ->> '$.action' IN (SELECT value FROM json_each('${JSON.stringify(ASK_ACTIONS)}'))
      AND h.value ->> '$.at' >= @from AND h.value ->> '$.at' <= @to${agentFilter("h.value ->> '$.by'")}`)).all(args) as { askId: string; agentId: string; at: string; jobId: string }[];
  for (const a of asks) acts.push({ agentId: a.agentId, at: a.at, jobId: a.jobId, key: a.askId });
  const entries = db.prepare(ofJob(`SELECT id, jobId, authorId AS agentId, createdAt AS at, answers, moved ->> '$.askId' AS askId FROM entries
    WHERE authorId LIKE 'ag\\_%' ESCAPE '\\' AND createdAt >= @from AND createdAt <= @to${agentFilter("authorId")}`)).all(args) as { id: string; jobId: string; agentId: string; at: string; answers: string | null; askId: string | null }[];
  for (const e of entries) acts.push({ agentId: e.agentId, at: e.at, jobId: e.jobId, key: e.askId ?? (e.answers?.startsWith("en_") ? e.answers.slice(3) : e.id) });
  return acts;
}

const DAY = 86_400_000;

/** managerShares over the manage sessions that ended (or started, while running) in [from, now]: GET /api/finance/spend `managerShares`. */
export function townManagerShares(world: World, from: string, now = new Date()): ManagerShares {
  const since = new Date(Date.parse(from) - DAY).toISOString();
  return managerShares({
    sessions: world.sessions.where("purpose = 'manage' AND COALESCE(endedAt, startedAt) >= ?", [from]),
    // a wake ending in the window may have started up to a day before it
    acts: managerActs(world, since, now.toISOString()),
    agents: world.agents.all(),
  }, now);
}

/**
 * What managing one job cost (all time): its line of the split over the wakes that worked it. Only the wakes that hold
 * one of the job's acts are read, with every act of their agents in them (to know what else each wake worked).
 */
export function jobManaging(world: World, jobId: string, now = new Date()): ManagingLine {
  const mine = managerActs(world, "0000", now.toISOString(), { jobId });
  if (!mine.length) return { tokens: 0, wakes: 0, decisions: 0 };
  const agentIds = [...new Set(mine.map((a) => a.agentId))];
  const first = mine.reduce((m, a) => (a.at < m ? a.at : m), mine[0]!.at);
  const holds = (s: Pick<Session, "agentId" | "startedAt" | "endedAt">) => {
    const start = Date.parse(s.startedAt), end = s.endedAt ? Date.parse(s.endedAt) : now.getTime();
    return mine.some((a) => a.agentId === s.agentId && Date.parse(a.at) >= start && Date.parse(a.at) <= end);
  };
  // only the wakes that hold one of this job's acts
  const sessions = world.sessions.where(
    `purpose = 'manage' AND meetingId IS NULL AND agentId IN (SELECT value FROM json_each(?)) AND COALESCE(endedAt, ?) >= ? AND startedAt >= ?`,
    [JSON.stringify(agentIds), now.toISOString(), first, new Date(Date.parse(first) - DAY).toISOString()],
  ).filter(holds);
  if (!sessions.length) return { tokens: 0, wakes: 0, decisions: 0 };
  const from = sessions.reduce((m, s) => (s.startedAt < m ? s.startedAt : m), sessions[0]!.startedAt);
  const to = sessions.reduce((m, s) => ((s.endedAt ?? now.toISOString()) > m ? s.endedAt ?? now.toISOString() : m), from);
  const split = managerShares({ sessions, acts: managerActs(world, from, to, { agentIds }), agents: world.agents.all() }, now);
  return split.jobs[jobId] ?? { tokens: 0, wakes: 0, decisions: 0 };
}
