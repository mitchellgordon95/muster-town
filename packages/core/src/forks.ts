/**
 * Manager forks (design note dc_mymt27yz25, step 1): a building with `forks` on queues work to the building; a fork is a
 * short-lived resident row ("Pix 3", forkOf = the manager) that takes a free desk (never growing the lab), works one
 * assignment and is retired when its session ends. The runtime (step 2) calls `forkManager` and `retireFork`.
 */
import { Agent, type Assignment, type Building } from "@muster-town/schema";
import { AppError, badRequest } from "./errors.ts";
import { buildingQueue, homeOf, managerAgentOf } from "./domain.ts";
import { interruptNow, isWorking } from "./wakes.ts";
import { sessionView } from "./bank.ts";
import { buildingRoleId } from "./permissions.ts";
import { newId, nowIso } from "./util.ts";
import type { World } from "./world.ts";
import { stamp } from "./time.ts";

/** The models a building's fork may run on: its work model and its cheap model. */
export function forkModels(b: Building): string[] {
  return [...new Set([b.model, b.cheapModel])];
}

/** Check a per-assignment model override (`assign … model`) against the models the building allows. */
export function checkForkModel(b: Building, model: string | undefined | null): string | null {
  if (!model) return null;
  if (!forkModels(b).includes(model)) throw badRequest(`${b.name} runs forks on ${forkModels(b).join(" or ")}, not ${model}.`);
  return model;
}

/** The lowest n ≥ 1 that no live (not retired) fork of the manager uses. */
export function nextForkN(world: World, managerId: string): number {
  const used = new Set(world.agents.where("forkOf = ? AND status != 'retired'", [managerId]).map((a) => a.forkN));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

/**
 * Step 2, the runtime's spawn check: the building-queue work a fork may start now, in queue order. Empty when there is
 * no manager to fork, the building's budget or the family's daily cap is spent. Waiting and offered rows
 * are skipped; a row the lane gate holds keeps its `heldReason` (as for a resident's queue).
 */
export function forkableQueue(world: World, b: Building): Assignment[] {
  const manager = managerAgentOf(world, b);
  if (!manager || manager.status === "banned" || manager.status === "retired") return [];
  if (world.budget.remaining(b.id) <= 0) return [];
  return buildingQueue(world, b.id).filter((a) => !a.waitFor && !a.offered && world.budget.holdReason(a) === null);
}

/** Desks a fork can take: the building's headcount minus the desks in use (named residents' and live forks'). */
export const freeDesks = (world: World, b: Building): number => Math.max(0, b.headcount - world.layout.deskCount(b.id));

/** Live (not retired) forks, e.g. for the runtime's sweep of forks whose session is gone. */
export const liveForks = (world: World): Agent[] => world.agents.where("forkOf IS NOT NULL AND status != 'retired'");

/** The desk number (0-based, as in the `desks` table) the agent sits at, or null. */
function deskN(world: World, agentId: string): number | null {
  const r = world.db.prepare("SELECT n FROM desks WHERE agentId = ?").get(agentId) as { n: number } | undefined;
  return r?.n ?? null;
}

/**
 * Soft desk affinity (§2.5): the desk the chain's latest fork sat at in this building, from its `agent.forked` event, so
 * a continuation lands on the home volume that holds the chain's desk files when that desk is free.
 */
export function chainDesk(world: World, buildingId: string, chainId: string): number | null {
  const r = world.db.prepare(
    "SELECT json_extract(payload, '$.desk') AS n FROM events WHERE type = 'agent.forked' AND buildingId = ? AND json_extract(payload, '$.chainId') = ? ORDER BY id DESC LIMIT 1",
  ).get(buildingId, chainId) as { n: number | null } | undefined;
  return typeof r?.n === "number" ? r.n : null;
}

/** A desk slot's sandbox (Machine or container) and home volume (§2.5, table desk_slots). */
export interface DeskSlotRow { buildingId: string; n: number; sandboxName: string; volumeName: string; createdAt: string }

/** The slot's row, or null when no fork has used it yet. */
export function deskSlotRow(world: World, buildingId: string, n: number): DeskSlotRow | null {
  return (world.db.prepare("SELECT buildingId, n, sandboxName, volumeName, createdAt FROM desk_slots WHERE buildingId = ? AND n = ?").get(buildingId, n) as DeskSlotRow | undefined) ?? null;
}

export function deskSlotRows(world: World, buildingId?: string): DeskSlotRow[] {
  return world.db.prepare(`SELECT buildingId, n, sandboxName, volumeName, createdAt FROM desk_slots${buildingId ? " WHERE buildingId = ?" : ""} ORDER BY buildingId, n`)
    .all(...(buildingId ? [buildingId] : [])) as DeskSlotRow[];
}

/**
 * Set a slot's sandbox and volume names. Step 7's volume adoption points a slot at a resident's existing home
 * (`volumeName: "deskhome-<agentId>"`) so its ~/pw, notes and checkouts carry over to the forks at that desk; the
 * slot's sandbox must then be recreated (removed while idle) to mount it.
 */
export function setDeskSlot(world: World, buildingId: string, n: number, names: { sandboxName: string; volumeName: string }): DeskSlotRow {
  world.buildings.require(buildingId, "building");
  if (!Number.isInteger(n) || n < 0) throw badRequest(`Desk slot ${n} isn't a desk number.`);
  world.db.prepare(
    "INSERT INTO desk_slots (buildingId, n, sandboxName, volumeName, createdAt) VALUES (?, ?, ?, ?, ?) ON CONFLICT(buildingId, n) DO UPDATE SET sandboxName = excluded.sandboxName, volumeName = excluded.volumeName",
  ).run(buildingId, n, names.sandboxName, names.volumeName, nowIso());
  return deskSlotRow(world, buildingId, n)!;
}

/**
 * The desk slot a fork works in (its building and desk n), created with `defaults` on first use; null for a named
 * resident (per-agent desk until step 7) or a fork without a desk.
 */
export function forkDeskSlot(world: World, agentId: string, defaults: (buildingId: string, n: number) => { sandboxName: string; volumeName: string }): DeskSlotRow | null {
  const a = world.agents.get(agentId);
  if (!a?.forkOf) return null;
  const r = world.db.prepare("SELECT buildingId, n FROM desks WHERE agentId = ?").get(agentId) as { buildingId: string; n: number } | undefined;
  if (!r) return null;
  return deskSlotRow(world, r.buildingId, r.n) ?? setDeskSlot(world, r.buildingId, r.n, defaults(r.buildingId, r.n));
}

/**
 * Fork the building's manager for a building-queue assignment, in one transaction: a new resident row ("<Manager> <n>",
 * the manager's sprite, the assignment's model or the building's, the resident permission set), the lowest free desk
 * WITHOUT growing the lab (refused when every desk is taken), the assignment handed to the fork, and `agent.forked`.
 * The caller (the runtime) then starts the work session.
 */
export function forkManager(world: World, buildingId: string, assignmentId: string): { fork: Agent; desk: number; assignment: Assignment } {
  const b = world.buildings.require(buildingId, "building");
  const manager = managerAgentOf(world, b);
  if (!manager) throw new AppError("conflict", `${b.name} has no manager agent to fork.`);
  const a = world.assignments.require(assignmentId, "assignment");
  if (a.buildingId !== b.id || a.queue !== "building") throw badRequest(`"${a.title}" isn't on ${b.name}'s building queue.`);
  if (a.status !== "pending") throw new AppError("conflict", `"${a.title}" is ${a.status}, not queued.`);
  if (world.agents.get(a.agentId)?.forkOf) throw new AppError("conflict", `"${a.title}" was already taken by ${world.nameOf(a.agentId)}.`);
  return world.transaction(() => {
    const id = newId("ag");
    const n = nextForkN(world, manager.id);
    world.agents.upsert(Agent.parse({
      id, name: `${manager.name} ${n}`, kind: "resident", buildingId: b.id, homeBuildingId: b.id, ownerUserId: manager.ownerUserId,
      sprite: manager.sprite, model: a.model ?? b.model, pos: world.layout.door(b.id) ?? manager.pos, status: "idle",
      currentAssignmentId: a.id, inheritsOwner: false, forkOf: manager.id, forkN: n, createdAt: nowIso(),
    }), { silent: true });
    // desks stay the cap: no grow (claimDesk throws a conflict when the lab is full, and the transaction rolls back);
    // a continuation prefers its chain's last desk when free (soft affinity), else the lowest free one
    const chainId = a.chainId ?? a.id;
    const prefer = chainDesk(world, b.id, chainId);
    const place = world.layout.claimDesk(b.id, id, { prefer });
    const fork = world.agents.patch(id, { pos: place.pos });
    world.permissions.grant(fork, buildingRoleId(b.id, "member"));
    const assignment = world.assignments.upsert({ ...a, agentId: id, updatedAt: nowIso() });
    const desk = deskN(world, id)!;
    const chainReportId = a.fromReportId ?? (world.db.prepare(
      "SELECT id FROM docs WHERE type = 'report' AND assignmentId IN (SELECT id FROM assignments WHERE chainId = ?) ORDER BY createdAt DESC, rowid DESC LIMIT 1",
    ).get(a.chainId ?? a.id) as { id: string } | undefined)?.id ?? null;
    world.events.append({
      type: "agent.forked", agentId: id, buildingId: b.id, text: `${manager.name} forked ${fork.name} for "${a.title}" at desk ${desk}`,
      payload: { forkOf: manager.id, forkN: n, desk, assignmentId: a.id, chainId, chainReportId, model: fork.model, chainDesk: prefer, sameDesk: prefer === desk },
    });
    return { fork, desk, assignment };
  });
}

/**
 * Retire a fork at the end of its session, whatever the outcome: queued work it still holds goes back on the building
 * queue, its desk is released, its tokens revoked and memberships removed, status `retired` (the row stays, so its docs
 * keep their author), and `agent.retired` with the report and the adjusted tokens it spent. Idempotent.
 */
export function retireFork(world: World, forkId: string, outcome: { reportId?: string | null; reason?: string } = {}): Agent {
  const fork = world.agents.require(forkId, "agent");
  if (!fork.forkOf) throw badRequest(`${fork.name} isn't a fork.`);
  if (fork.status === "retired") return fork;
  return world.transaction(() => {
    world.movement.cancel(forkId, "Retired.");
    const requeued: string[] = [];
    for (const a of world.assignments.where("agentId = ? AND status = 'pending'", [forkId])) {
      world.assignments.upsert({ ...a, agentId: fork.forkOf!, queue: "building", updatedAt: nowIso() });
      requeued.push(a.id);
    }
    const revokedTokens = world.tokens.revokeAll("agent", forkId);
    world.memberships.removeAll("agent", forkId);
    const desk = deskN(world, forkId);
    if (desk !== null) world.layout.releaseDesk(forkId);
    world.agents.patch(forkId, { currentAssignmentId: null, currentMeetingId: null, activity: "" });
    const reportId = outcome.reportId ?? null;
    const tokens = fork.spentTokensTotal;
    const retired = world.setStatus(forkId, "retired", `${fork.name} retired`);
    world.events.append({
      type: "agent.retired", agentId: forkId, buildingId: fork.homeBuildingId,
      text: `${fork.name} retired (${reportId ? `report ${reportId}` : outcome.reason ?? "no report"}, ${Math.round(tokens / 1000)}k adj. tokens)`,
      payload: { forkOf: fork.forkOf, forkN: fork.forkN, reportId, tokens, desk, requeued, revokedTokens, ...(outcome.reason ? { reason: outcome.reason } : {}) },
    });
    return retired;
  });
}

/** One fork as the web shows it (step 5): its assignment, chain hop, session (tokens), report and the topic pages it edited. */
export interface ForkSummary {
  agent: Agent;
  forkOfName: string;
  assignmentId: string | null;
  assignmentTitle: string | null;
  chainId: string | null;
  hop: number | null;
  sessionId: string | null;
  tokens: number;
  /** the session's wall, CPU and steal ms (gr_uhh6u39vv9); null = running or not measured */
  wallMs: number | null;
  cpuMs: number | null;
  stealMs: number | null;
  /** the desk Machine size the session ran on (gr_uhh6u39vv9 step 3); null = host, docker or before migration 060 */
  cpuKind: "shared" | "performance" | null;
  cpus: number | null;
  memoryMb: number | null;
  transcript: boolean;
  reportId: string | null;
  reportTitle: string | null;
  pagesEdited: { id: string; title: string }[];
}

/** A report's place on its assignment chain (§5.3): the chain, which hop it is (1 = first assignment) and the previous hop's report. */
export interface ReportChain { chainId: string; hop: number; prevReportId: string | null; sessionId: string | null; assignmentId: string; forkOf: string | null }

/** The chain a report belongs to, or null when it has no assignment. Hop counts the chain's assignments created up to its own. */
export function reportChain(world: World, doc: { id: string; authorId?: string; assignmentId?: string | null; sessionId?: string | null; createdAt: string }): ReportChain | null {
  const a = doc.assignmentId ? world.assignments.get(doc.assignmentId) : null;
  if (!a) return null;
  const chainId = a.chainId ?? a.id;
  // ties on createdAt (same millisecond) fall back to insert order
  const hop = (world.db.prepare(
    "SELECT COUNT(*) AS n FROM assignments WHERE (chainId = ? OR id = ?) AND (createdAt < ? OR (createdAt = ? AND rowid <= (SELECT rowid FROM assignments WHERE id = ?)))",
  ).get(chainId, chainId, a.createdAt, a.createdAt, a.id) as { n: number }).n;
  const prev = world.db.prepare(
    "SELECT id FROM docs WHERE type = 'report' AND id != ? AND assignmentId != ? AND createdAt <= ? AND assignmentId IN (SELECT id FROM assignments WHERE chainId = ? OR id = ?) ORDER BY createdAt DESC, rowid DESC LIMIT 1",
  ).get(doc.id, a.id, doc.createdAt, chainId, chainId) as { id: string } | undefined;
  return { chainId, hop: Math.max(1, hop), prevReportId: prev?.id ?? null, sessionId: doc.sessionId ?? null, assignmentId: a.id, forkOf: (doc.authorId ? world.agents.get(doc.authorId)?.forkOf : null) ?? null };
}

/** Chains of the fork-authored reports among `docs`, by doc id (the in-tray's chain badges). Named residents' reports are left out. */
export function reportChains(world: World, docs: { id: string; authorId: string; assignmentId?: string | null; sessionId?: string | null; createdAt: string }[]): Record<string, ReportChain> {
  const out: Record<string, ReportChain> = {};
  for (const d of docs) {
    if (!world.agents.get(d.authorId)?.forkOf) continue;
    const c = reportChain(world, d);
    if (c) out[d.id] = c;
  }
  return out;
}

/** A fork's summary from its latest session (live or retired); null for an agent that isn't a fork. */
export function forkSummary(world: World, fork: Agent): ForkSummary | null {
  if (!fork.forkOf) return null;
  const session = world.sessions.first("agentId = ?", [fork.id], "ORDER BY startedAt DESC, rowid DESC") ?? null;
  const report = (session?.reportId ? world.docs.get(session.reportId) : null) ?? world.docs.first("type = 'report' AND authorId = ?", [fork.id], "ORDER BY createdAt DESC, rowid DESC") ?? null;
  // a retired fork's assignment may be back on the building queue: its spawn event still names it
  const forked = world.db.prepare("SELECT json_extract(payload, '$.assignmentId') AS id FROM events WHERE type = 'agent.forked' AND agentId = ? ORDER BY id DESC LIMIT 1").get(fork.id) as { id: string | null } | undefined;
  const asgId = fork.currentAssignmentId ?? session?.assignmentId ?? report?.assignmentId ?? forked?.id ?? null;
  const asg = asgId ? world.assignments.get(asgId) : null;
  const chain = asg ? reportChain(world, { id: report?.id ?? "", assignmentId: asg.id, createdAt: report?.createdAt ?? asg.createdAt }) : null;
  const pages = world.db.prepare(
    `SELECT id, title FROM docs WHERE topicOf IS NOT NULL AND (authorId = ? OR id IN (SELECT docId FROM doc_revisions WHERE replacedBy = ?)) ORDER BY updatedAt DESC`,
  ).all(fork.id, fork.id) as { id: string; title: string }[];
  return {
    agent: fork, forkOfName: world.nameOf(fork.forkOf), assignmentId: asg?.id ?? null, assignmentTitle: asg?.title ?? null,
    chainId: chain?.chainId ?? null, hop: chain?.hop ?? null, sessionId: session?.id ?? null, tokens: session ? sessionView(session).adjustedOutputTokens : 0,
    wallMs: session?.wallMs ?? null, cpuMs: session?.cpuMs ?? null, stealMs: session?.stealMs ?? null,
    cpuKind: session?.cpuKind ?? null, cpus: session?.cpus ?? null, memoryMb: session?.memoryMb ?? null,
    transcript: !!session && world.transcripts.info(session.id) !== null, reportId: report?.id ?? null, reportTitle: report?.title ?? null, pagesEdited: pages,
  };
}

/**
 * What a manager and all its forks (live and retired) spent, summed from the rows the Bank books; a read-side sum only.
 * `forksToday` is the forks' part of `today` (no daily cap since 2026-10-31).
 * A fork's spend is booked when its session ends, so a running fork adds nothing yet.
 */
export interface FamilySpend { today: number; forksToday: number; total: number; usdTotal: number; forks: number }

/** Design note §7 "rollups by family": the manager's own spend plus every fork's, today and all-time, in adjusted tokens. */
export function familySpend(world: World, managerId: string): FamilySpend {
  const r = world.db.prepare(
    "SELECT COALESCE(SUM(spentTokensToday), 0) AS today, COALESCE(SUM(CASE WHEN forkOf IS NOT NULL THEN spentTokensToday ELSE 0 END), 0) AS forksToday, COALESCE(SUM(spentTokensTotal), 0) AS total, COALESCE(SUM(spentUsdTotal), 0) AS usd, COALESCE(SUM(forkOf IS NOT NULL), 0) AS forks FROM agents WHERE id = ? OR forkOf = ?",
  ).get(managerId, managerId) as { today: number; forksToday: number; total: number; usd: number; forks: number };
  return { today: r.today, forksToday: r.forksToday, total: r.total, usdTotal: r.usd, forks: r.forks };
}

/**
 * A manager's forks for its Forks tab: the live ones, then the last 50 retired that started a session, newest first,
 * and the family's spend. Forks whose desk failed before any session (they spent nothing) are only counted
 * (`notStarted`): listed, a burst of them pushed every fork that did work out of the 50 (as_v969ocjeol).
 */
export function forksOf(world: World, managerId: string): { live: ForkSummary[]; retired: ForkSummary[]; notStarted: number; family: FamilySpend } {
  const live = world.agents.where("forkOf = ? AND status != 'retired'", [managerId], "ORDER BY forkN");
  const started = "EXISTS (SELECT 1 FROM sessions s WHERE s.agentId = agents.id)";
  const retired = world.agents.where(`forkOf = ? AND status = 'retired' AND ${started}`, [managerId], "ORDER BY createdAt DESC, rowid DESC LIMIT 50");
  const { n: notStarted } = world.db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE forkOf = ? AND status = 'retired' AND NOT ${started}`).get(managerId) as { n: number };
  return { live: live.map((a) => forkSummary(world, a)!), retired: retired.map((a) => forkSummary(world, a)!), notStarted, family: familySpend(world, managerId) };
}

// ---- stop_fork (agent teams step 4, dc_i7ji4xacd9): ask a live fork to wrap up, hard stop after a timeout ----

/** How long a fork asked to stop has to file its report before the town stops its session (agent teams step 4). */
export const STOP_FORK_TIMEOUT_MS = 5 * 60_000;

/**
 * `stop_fork` (manager: building.assign on the fork's building): interrupt a fork's running work session with
 * "finish this step, write your pages, submit_report now", and log the request with its deadline. `stopOverdueForks`
 * stops the session hard if no report has landed by then (the stopped path writes the "Session ended without a report"
 * report and cancels the assignment). Asking twice for one session keeps the first deadline.
 */
export function requestForkStop(world: World, me: Agent, input: { forkId?: string; assignmentId?: string; reason?: string }, now = new Date()) {
  if (!!input.forkId === !!input.assignmentId) throw badRequest("Give forkId (a live fork) or assignmentId (the assignment it is running), not both.");
  const forkId = input.forkId ?? world.assignments.require(input.assignmentId!, "assignment").agentId;
  const fork = world.agents.require(forkId, "agent");
  if (!fork.forkOf) throw badRequest(`${fork.name} is not a fork; stop_fork stops forks only.`);
  if (fork.id === me.id) throw badRequest("You can't stop yourself: submit_report ends your session.");
  const bid = homeOf(fork);
  if (!bid || !world.permissions.can(me, "building.assign", bid)) throw new AppError("forbidden", `Only the manager of ${fork.name}'s building can stop it (building.assign).`);
  if (fork.status === "retired" || fork.status === "stopped" || fork.status === "banned") throw new AppError("conflict", `${fork.name} is ${fork.status}.`);
  const session = world.sessions.first("agentId = ? AND status = 'running' AND purpose = 'work'", [fork.id], "ORDER BY startedAt DESC, rowid DESC");
  if (!session || !isWorking(world, fork.id)) throw new AppError("conflict", `${fork.name} has no running work session.`);
  if (input.assignmentId && session.assignmentId !== input.assignmentId) throw new AppError("conflict", `${fork.name} is not running ${input.assignmentId} now (it is on ${session.assignmentId ?? "no assignment"}).`);
  const prior = world.events.list({ agentId: fork.id, types: ["system"], payloadKey: "stopFork", desc: true, limit: 20 })
    .find((e) => e.payload.stopFork === "requested" && e.payload.sessionId === session.id);
  if (prior) return { forkId: fork.id, sessionId: session.id, deadline: String(prior.payload.deadline), note: `${fork.name} was already asked to stop; the hard stop stays at ${stamp(String(prior.payload.deadline))}.` };
  const deadline = new Date(now.getTime() + STOP_FORK_TIMEOUT_MS).toISOString();
  const at = stamp(deadline);
  const reason = (input.reason ?? "").trim();
  interruptNow(world, fork.id, `${me.name} asks you to stop now${reason ? `: ${reason}` : "."}\n\nDon't start anything new. Finish the step you are on (leave the code committed and pushed if you changed any), update the topic pages and log lines for what you learnt, then call submit_report right away: say what is done and what is not, and put what the next session needs in Findings (verdict continue if the work is unfinished). If you have not submitted by ${at} (${STOP_FORK_TIMEOUT_MS / 60_000} min), the town stops your session and files a fallback report.`, me.name);
  const req = world.events.append({ type: "system", agentId: fork.id, buildingId: bid, text: `${me.name} asked ${fork.name} to wrap up and file its report (hard stop at ${at})${reason ? `: ${reason.slice(0, 160)}` : ""}`, payload: { stopFork: "requested", forkId: fork.id, sessionId: session.id, assignmentId: session.assignmentId, by: me.id, reason: reason || null, deadline } });
  setPendingStops(world, [...pendingStops(world, now), { eventId: req.id, forkId: fork.id, sessionId: session.id, by: me.id, deadline }]);
  return { forkId: fork.id, sessionId: session.id, deadline, note: `${fork.name} was interrupted: finish its step, write its pages and submit_report. If no report by ${at}, the town stops it and files "Session ended without a report"; either way the fork retires and its report reaches your in-tray.` };
}

/**
 * The runtime's tick: forks asked to stop (`requestForkStop`, last day) whose deadline passed and whose session is still
 * running are stopped hard (`stopAgent` → the waker aborts the session → fallback report, assignment cancelled → retired).
 * A fork that filed its report but is still running past the deadline is stopped too. Returns the forks stopped.
 */
export function stopOverdueForks(world: World, now = new Date()): string[] {
  const pending = pendingStops(world, now);
  if (!pending.length) return [];
  const stopped: string[] = [];
  const left: PendingStop[] = [];
  for (const p of pending) {
    if (Date.parse(p.deadline) > now.getTime()) { left.push(p); continue; }
    // past its deadline: stopped now or never (a session that is not running at the deadline never runs again)
    const fork = world.agents.get(p.forkId);
    const session = world.sessions.get(p.sessionId);
    if (!fork || session?.status !== "running" || fork.status === "retired" || fork.status === "stopped" || fork.status === "banned") continue;
    const by = world.agents.get(p.by)?.name ?? "its manager";
    world.events.append({ type: "system", agentId: fork.id, buildingId: homeOf(fork), text: `${fork.name} ${session.reportId ? "filed its report but was still running" : "did not file its report"} ${STOP_FORK_TIMEOUT_MS / 60_000} min after ${by} asked it to stop: session stopped`, payload: { stopFork: "hard", forkId: fork.id, sessionId: session.id, assignmentId: session.assignmentId, by: p.by, reportId: session.reportId ?? null, requestEventId: p.eventId } });
    world.ops.stopAgent(null, fork.id);
    stopped.push(fork.id);
  }
  setPendingStops(world, left);
  return stopped;
}

/** A `requestForkStop` waiting for its deadline, kept in `meta` so the 5 s tick reads one row, not the system events. */
interface PendingStop { eventId: number; forkId: string; sessionId: string; by: string; deadline: string }
const PENDING_STOPS_MARKER = "pendingForkStops";

/**
 * The stop requests waiting for their deadline. Before the marker was first written (a town that ran the old event
 * scan), it is seeded once from the last day's `stopFork: "requested"` system events.
 */
function pendingStops(world: World, now: Date): PendingStop[] {
  const raw = world.town.marker(PENDING_STOPS_MARKER);
  if (raw !== null) return JSON.parse(raw) as PendingStop[];
  const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const seeded = world.events.list({ types: ["system"], payloadKey: "stopFork", from: since, limit: 500 })
    .filter((e) => e.payload.stopFork === "requested")
    .map((e) => ({ eventId: e.id, forkId: String(e.payload.forkId), sessionId: String(e.payload.sessionId), by: String(e.payload.by), deadline: String(e.payload.deadline) }));
  setPendingStops(world, seeded);
  return seeded;
}

function setPendingStops(world: World, list: PendingStop[]): void {
  world.town.setMarker(PENDING_STOPS_MARKER, JSON.stringify(list));
}
