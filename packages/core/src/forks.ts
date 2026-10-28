/**
 * Manager forks (design note dc_mymt27yz25, step 1): a building with `forks` on queues work to the building; a fork is a
 * short-lived resident row ("Pix 3", forkOf = the manager) that takes a free desk (never growing the lab), works one
 * assignment and is retired when its session ends. The runtime (step 2) calls `forkManager` and `retireFork`.
 */
import { Agent, type Assignment, type Building } from "@muster-town/schema";
import { AppError, badRequest } from "./errors.ts";
import { buildingQueue, managerAgentOf } from "./domain.ts";
import { familyCap } from "./budget.ts";
export { familyCap };
import { buildingRoleId } from "./permissions.ts";
import { newId, nowIso } from "./util.ts";
import type { World } from "./world.ts";

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
 * Step 2, the runtime's spawn check: the building-queue work a fork may start now, in queue order. Empty when forks are
 * off, there is no manager to fork, the building's budget or the family's daily cap is spent. Waiting and offered rows
 * are skipped; a row the lane gate holds keeps its `heldReason` (as for a resident's queue).
 */
export function forkableQueue(world: World, b: Building): Assignment[] {
  if (!b.forks) return [];
  const manager = managerAgentOf(world, b);
  if (!manager || manager.status === "banned" || manager.status === "retired") return [];
  if (world.budget.remaining(b.id) <= 0 || manager.familySpentToday >= familyCap(b)) return [];
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
  if (!b.forks) throw badRequest(`${b.name} doesn't run forks (its \`forks\` setting is off).`);
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
