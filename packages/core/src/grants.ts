import {
  CloseGrantInput, CreateGrantInput, CreateObjectiveInput, DecideGrantInput, MAX_KEY_RESULTS_PER_OBJECTIVE, MAX_OBJECTIVES,
  UpdateGrantInput, UpdateKeyResultInput, type GrantKeyResultInput, UpdateObjectiveInput, type KpiKey, type Objective,
  type Building, type Grant, type GrantHistoryEntry, type GrantStatus, type GrantView, type KeyResult, type Session, type Stoplight, type TokenCounts, ZERO_TOKENS, addTokens, stoplightOf, GrantKeyResultInput as GrantKrInput,
} from "@muster-town/schema";
import { adjustedOfUsage } from "./bank.ts";
import { createAssignment, managerAgentOf, sendMessage } from "./domain.ts";
import type { EventType } from "./events.ts";
import { AppError, badRequest, forbidden, notFound } from "./errors.ts";
import type { Actor } from "./ops.ts";
import { DIRECTED } from "./lanes.ts";
import { goalFunding } from "./free-tokens.ts";
import { holderOf } from "./permissions.ts";
import { queuePostmortem } from "./postmortems.ts";
import { whereOf } from "./table.ts";
import { newId, nowIso } from "./util.ts";
import type { World } from "./world.ts";

/**
 * Spend fractions at which a funded grant pauses for a human checkpoint: only 100% ("a grant is good for the number
 * granted", Mitchell, town hall mt_rjhwj2qggm). The 50% one is gone; `releaseHalfway` frees grants it still holds.
 */
export const CHECKPOINTS = [1] as const;

const LIVE: GrantStatus[] = ["funded", "checkpoint"];
const TERMINAL: GrantStatus[] = ["closed", "rejected"];
const isOpenKr = (k: KeyResult) => !k.archivedAt && k.status !== "met" && k.status !== "missed";

/** Why a goal-directed building is blocked (shown on GET /api/buildings/:id, the board and the Town Hall in-tray). */

/**
 * Today's exploration of a building (docs/how-work-gets-done.md §8): no allowance. What it spent today, the free tokens
 * under its goal (exploration's only money gate) and the optional cap inherited from its goal (null = uncapped) with what
 * the capping goal's subtree spent on exploration today.
 */
export interface ExplorationBudget { spentTodayTokens: number; freeTokens: number; cap: { tokensPerDay: number; goalId: string; spentTodayTokens: number } | null }
/** A goal key result with the live (funded or checkpoint) grant working on it, if any. */
/** A goal key result as the API returns it: the live grant on it, and the names of who wrote / last edited it (null = unknown or never). */
export type GoalKeyResult = KeyResult & { createdByName: string | null; editedByName: string | null };
/** Today's (UTC) spend on directed work (a human asked for it): metered in its own bucket, never held by the allowance. */
export interface DirectedBudget { spentTodayTokens: number }
/** An objective as the API returns it: the KPI it moves (key and name) and its key results in order. */
export type ObjectiveView = Objective & { kpi: KpiKey | null; kpiName: string | null; keyResults: GoalKeyResult[]; createdByName: string | null; editedByName: string | null };
/** GET /api/buildings/:id/objectives: the goal's objectives with their key results, then the key results under none. */
export interface ObjectiveTree { objectives: ObjectiveView[]; unsorted: GoalKeyResult[] }
/** The quarter `iso` falls in (UTC), e.g. "2026-Q4": an objective's default horizon. */
export function quarterOf(iso: string = nowIso()): string {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

export interface GrantBoard { goal: string; keyResults: GoalKeyResult[]; objectives: ObjectiveTree; blocked: string | null; stoplight: Stoplight | null; grants: GrantView[]; proposals: GrantView[]; exploration: ExplorationBudget; directed: DirectedBudget }
export interface BlockedBuilding { buildingId: string; name: string; reason: string; since: string | null }

/**
 * Goal-directed budgets: a building's proposals and grants (design dc_k955hun6c4). The manager drafts and proposes
 * (`building.manage`); a human with `building.fund` funds, counters, rejects and decides checkpoints. Spend is derived
 * from sessions (SUM of tokens by grantId), never stored. `null` actor = system: no permission checks.
 */
export class Grants {
  constructor(private world: World) {}

  /** A grant's spend in adjusted output tokens (Bank step 3): its sessions' adjustedOutputTokens, summed. */
  spent(grantId: string): number {
    return this.adjustedSum(this.world.sessions.where("grantId = ?", [grantId]));
  }

  private adjustedSum(sessions: Session[]): number {
    return sessions.reduce((s, x) => s + adjustedOfUsage(x.model, x, x.byModel), 0);
  }

  view(g: Grant): GrantView {
    const sessions = this.world.sessions.where("grantId = ?", [g.id]);
    const spentCounts = sessions.reduce<TokenCounts>((s, x) => addTokens(s, x), { ...ZERO_TOKENS });
    return {
      ...g, keyResult: (g.keyResultId && this.world.keyResults.get(g.keyResultId)) || null, keyResults: this.keyResultsOf(g.id), spentTokens: this.adjustedSum(sessions), spentCounts,
      fundedByName: g.fundedBy ? this.world.nameOf(g.fundedBy) : null, fundedWithLabel: g.fundedWith ? this.world.bank.input(g.fundedWith)?.label ?? null : null,
    };
  }

  /** A grant's own key results (docs/how-work-gets-done.md §4), in order. */
  keyResultsOf(grantId: string): KeyResult[] {
    return this.world.keyResults.where("grantId = ?", [grantId], "ORDER BY position, rowid");
  }

  /**
   * The key results in the building's subtree of the town goal tree (docs/goals.md), in order: its grants' (open and
   * archived, each with its `grantId`) and the archived ones written on goals before migration 069.
   */
  keyResults(buildingId: string): GoalKeyResult[] {
    return this.world.goalTree.keyResultsInScope(buildingId).map((k) => ({
      ...k, createdByName: k.createdBy ? this.world.nameOf(k.createdBy) : null, editedByName: k.editedBy ? this.world.nameOf(k.editedBy) : null,
    }));
  }

  /** The goal's objectives in order, each with its key results, then the key results under no objective ("Unsorted"). */
  objectiveTree(buildingId: string, krs: GoalKeyResult[] = this.keyResults(buildingId)): ObjectiveTree {
    const kpis = new Map(this.world.kpis.all().map((k) => [k.id, k]));
    const objectives = this.world.objectives.where("buildingId = ?", [buildingId], "ORDER BY position, rowid").map((o) => ({
      ...o, kpi: (o.kpiId && kpis.get(o.kpiId)?.key) || null, kpiName: (o.kpiId && kpis.get(o.kpiId)?.name) || null,
      keyResults: krs.filter((k) => k.objectiveId === o.id),
      createdByName: o.createdBy ? this.world.nameOf(o.createdBy) : null, editedByName: o.editedBy ? this.world.nameOf(o.editedBy) : null,
    }));
    const ids = new Set(objectives.map((o) => o.id));
    return { objectives, unsorted: krs.filter((k) => !k.objectiveId || !ids.has(k.objectiveId)) };
  }

  /**
   * POST /api/buildings/:id/objectives (and the manager's `set_objective`): an objective of the building goal, written
   * like key results (a human with `building.manage` or the building's own manager agent). At most MAX_OBJECTIVES.
   */
  createObjective(actor: Actor, buildingId: string, input: CreateObjectiveInput): Objective {
    const inp = CreateObjectiveInput.parse(input);
    const b = this.world.buildings.require(buildingId, "building");
    this.requireWriter(actor, b, "objectives");
    this.requireSources(inp.sourceDocIds);
    const n = this.world.objectives.count("buildingId = ?", [buildingId]);
    if (n >= MAX_OBJECTIVES) throw new AppError("conflict", `${b.name}'s goal already has ${n} objectives (at most ${MAX_OBJECTIVES}): edit one instead.`);
    const by = actor ? holderOf(actor) : null;
    const last = this.world.objectives.first("buildingId = ?", [buildingId], "ORDER BY position DESC");
    const o = this.world.objectives.upsert({
      id: newId("ob"), buildingId, position: last ? last.position + 1 : 0, text: inp.text, horizon: inp.horizon ?? quarterOf(),
      kpiId: inp.kpi ? this.kpiId(inp.kpi) : null, createdBy: by?.id ?? null, editedBy: null, sourceDocIds: inp.sourceDocIds, updatedAt: nowIso(),
    });
    // an objective is a goal of the town tree with the same id, under the building's attachment (docs/goals.md)
    this.world.goals.upsert({
      id: o.id, parentId: this.world.goalTree.attachmentOf(b), position: o.position, text: o.text, ownerId: null, status: "active", retiredAt: null, retiredBy: null, retiredNote: "",
      createdBy: o.createdBy, editedBy: null, sourceDocIds: o.sourceDocIds, exploreCapTokensPerDay: null, explore: null, exploreChunkTokens: null, createdAt: o.updatedAt, updatedAt: o.updatedAt,
    });
    this.world.events.append({
      type: "objective.created", agentId: actor?.id ?? null, buildingId, text: `${b.name} objective: ${o.text}`,
      payload: { objectiveId: o.id, by: by?.id ?? "system", byKind: by?.kind ?? "system", text: o.text, kpi: inp.kpi ?? null, horizon: o.horizon },
    });
    return o;
  }

  /** PATCH /api/objectives/:id (and `set_objective` with an id): the same writers as createObjective. */
  updateObjective(actor: Actor, id: string, input: UpdateObjectiveInput): Objective {
    const inp = UpdateObjectiveInput.parse(input);
    const o = this.world.objectives.require(id, "objective");
    this.requireWriter(actor, this.world.buildings.require(o.buildingId, "building"), "objectives");
    if (inp.sourceDocIds) this.requireSources(inp.sourceDocIds);
    const fields = {
      ...(inp.text !== undefined && { text: inp.text }), ...(inp.horizon !== undefined && { horizon: inp.horizon }),
      ...(inp.kpi !== undefined && { kpiId: inp.kpi ? this.kpiId(inp.kpi) : null }),
      ...(inp.sourceDocIds !== undefined && { sourceDocIds: inp.sourceDocIds }), ...(inp.position !== undefined && { position: inp.position }),
    };
    if (!Object.keys(fields).length) throw badRequest("Nothing to change: give text, kpi, horizon, sourceDocIds or position.");
    const by = actor ? holderOf(actor) : null;
    const next = this.world.objectives.upsert({ ...o, ...fields, editedBy: by?.id ?? null, updatedAt: nowIso() });
    const goal = this.world.goals.get(o.id);
    if (goal) this.world.goals.upsert({ ...goal, text: next.text, position: next.position, sourceDocIds: next.sourceDocIds, editedBy: next.editedBy, updatedAt: next.updatedAt });
    this.world.events.append({
      type: "objective.updated", agentId: actor?.id ?? null, buildingId: o.buildingId, text: `Objective edited: ${next.text}`,
      payload: { objectiveId: o.id, by: by?.id ?? "system", byKind: by?.kind ?? "system", text: next.text, fromText: o.text, kpiId: next.kpiId, horizon: next.horizon },
    });
    return next;
  }

  /** DELETE /api/objectives/:id: a human with `building.manage`; refused while key results hang off it. */
  deleteObjective(actor: Actor, id: string): void {
    const o = this.world.objectives.require(id, "objective");
    if (actor) {
      if (actor.kind !== "human") throw forbidden("building.manage", "Only a human deletes an objective.");
      this.world.permissions.require(actor, "building.manage", o.buildingId);
    }
    const n = this.world.keyResults.count("objectiveId = ?", [id]);
    if (n) throw new AppError("conflict", `${n} key result${n === 1 ? "" : "s"} hang off this objective: move ${n === 1 ? "it" : "them"} first.`);
    const kids = this.world.goals.count("parentId = ?", [id]) + this.world.keyResults.count("goalId = ?", [id]);
    if (kids) throw new AppError("conflict", `This objective is a goal of the town tree with ${kids} goal${kids === 1 ? "" : "s"} or key result${kids === 1 ? "" : "s"} under it: move them first.`);
    this.world.objectives.delete(id);
    this.world.goals.delete(id);
    this.world.events.append({ type: "objective.deleted", agentId: actor?.id ?? null, buildingId: o.buildingId, text: `Objective removed: ${o.text}`, payload: { objectiveId: id } });
  }

  private kpiId(key: KpiKey): string {
    const k = this.world.kpis.first("key = ?", [key]);
    if (!k) throw badRequest(`Unknown KPI ${key}.`);
    return k.id;
  }

  /** A key result's objective must be one of its building's, with room for one more (at most MAX_KEY_RESULTS_PER_OBJECTIVE). */
  private requireObjectiveRoom(buildingId: string, objectiveId: string, movingId?: string): void {
    const o = this.world.objectives.get(objectiveId);
    if (!o || o.buildingId !== buildingId) throw badRequest(`${objectiveId} is not an objective of this building's goal.`);
    const n = this.world.keyResults.count("objectiveId = ? AND id != ?", [objectiveId, movingId ?? ""]);
    if (n >= MAX_KEY_RESULTS_PER_OBJECTIVE) throw new AppError("conflict", `Objective ${objectiveId} already has ${n} key results (at most ${MAX_KEY_RESULTS_PER_OBJECTIVE}).`);
  }

  /** The live (funded or checkpoint) grant a key result belongs to, if any. */
  liveGrantOf(keyResultId: string): Grant | undefined {
    const grantId = this.world.keyResults.get(keyResultId)?.grantId;
    const g = grantId ? this.world.grants.get(grantId) : undefined;
    return g && LIVE.includes(g.status) ? g : undefined;
  }

  /**
   * A goal-directed building is never blocked for want of key results any more (docs/how-work-gets-done.md §4): they
   * belong to grants, and a building with no funded grant explores or idles (its stoplight is grey). Kept as the hook
   * the in-tray and the tick read; nothing blocks today.
   */
  blocked(_b: Building | string): string | null {
    return null;
  }

  /**
   * The building's stoplight (docs/how-work-gets-done.md §4; the map banner and the board): green = a funded grant runs,
   * yellow = a grant is held at its checkpoint, grey = no funded grant. The Town Hall: null.
   */
  stoplight(b: Building | string): Stoplight | null {
    const building = typeof b === "string" ? this.world.buildings.get(b) : b;
    if (!building || building.kind === "town-hall") return null;
    return stoplightOf(this.world.grants.where("buildingId = ? AND status IN ('funded', 'checkpoint')", [building.id], "ORDER BY fundedAt, rowid"));
  }

  /** Every blocked building (the Town Hall in-tray's summary). */
  blockedBuildings(): BlockedBuilding[] {
    return this.world.buildings.where("kind != 'town-hall'", [], "ORDER BY createdAt, rowid").flatMap((b) => {
      const reason = this.blocked(b);
      return reason ? [{ buildingId: b.id, name: b.name, reason, since: b.blockedAt ?? null }] : [];
    });
  }

  /**
   * Record a blocked transition (idempotent; the world calls it after grant, key-result and building changes, and the
   * scheduler on every tick). Into blocked: `blockedAt` is set, `building.blocked` appended, and the manager agent gets
   * one "Get human decisions" assignment (front of its queue). Out of it: `blockedAt` is cleared. One wake per transition.
   */
  syncBlocked(buildingId: string): void {
    const b = this.world.buildings.get(buildingId);
    if (!b) return;
    const reason = this.blocked(b);
    if (!!reason === !!b.blockedAt) return;
    const at = reason ? nowIso() : null;
    this.world.transaction(() => {
      this.world.buildings.upsert({ ...b, blockedAt: at });
      this.world.events.append({ type: "building.blocked", buildingId, text: reason ? `${b.name} is ${reason}` : `${b.name} is unblocked`, payload: { blocked: !!reason, reason } });
    });
  }

  get(id: string): GrantView {
    return this.view(this.world.grants.require(id, "grant"));
  }

  /** Newest first. Drafts are left out unless `includeDrafts` (the building's managers). */
  list(buildingId: string, opts: { status?: GrantStatus; includeDrafts?: boolean } = {}): GrantView[] {
    this.world.buildings.require(buildingId, "building");
    const where = whereOf({ buildingId, status: opts.status }, [!opts.includeDrafts && { sql: "status != 'draft'", params: [] }]);
    return this.world.grants.where(where.sql, where.params, "ORDER BY createdAt DESC, rowid DESC").map((g) => this.view(g));
  }

  /** Can this actor see drafts (and edit) in the building? */
  canManage(actor: Actor, buildingId: string): boolean {
    return !actor || this.world.permissions.can(actor, "building.manage", buildingId) || this.world.permissions.can(actor, "building.fund", buildingId);
  }

  /** Today's (UTC) exploration of the building: its spend, the free tokens under its goal, and the optional cap. */
  exploration(buildingId: string): ExplorationBudget {
    const b = this.world.buildings.require(buildingId, "building");
    const goalId = this.world.goalTree.attachmentOf(b);
    const f = goalFunding(this.world, goalId);
    const cap = f.exploreCap ? { ...f.exploreCap, spentTodayTokens: f.exploreSpentTodayTokens } : null;
    return { spentTodayTokens: this.laneSpentToday(buildingId, "exploration"), freeTokens: f.free.freeTokens, cap };
  }

  /** Today's (UTC) directed spend of the building's residents (1:1 mt_ryw7ejayvu: its own bucket, next to exploration). */
  directed(buildingId: string): DirectedBudget {
    this.world.buildings.require(buildingId, "building");
    return { spentTodayTokens: this.laneSpentToday(buildingId, "directed") };
  }

  /** Session tokens in one lane of the building's residents since 00:00 UTC. */
  laneSpentToday(buildingId: string, lane: "exploration" | "directed", now = new Date()): number {
    const day = new Date(now); day.setUTCHours(0, 0, 0, 0);
    return this.adjustedSum(this.world.sessions.where(
      "lane = ? AND startedAt >= ? AND agentId IN (SELECT id FROM agents WHERE homeBuildingId = ?)", [lane, day.toISOString(), buildingId]));
  }

  /** GET /api/health's `budgets`: each lab's exploration and directed spend today. */
  laneBudgets(): { buildingId: string; name: string; exploration: ExplorationBudget; directed: DirectedBudget }[] {
    return this.world.buildings.where("kind != 'town-hall'", [], "ORDER BY rowid")
      .map((b) => ({ buildingId: b.id, name: b.name, exploration: this.exploration(b.id), directed: this.directed(b.id) }));
  }

  /** GET /api/buildings/:id/board's budget part: live grants, the open proposals (newest first), exploration today. */
  board(buildingId: string): GrantBoard {
    const b = this.world.buildings.require(buildingId, "building");
    const live = this.world.grants.where(`buildingId = ? AND status IN ('funded', 'checkpoint')`, [buildingId], "ORDER BY fundedAt, rowid");
    const open = this.world.grants.where(`buildingId = ? AND status IN ('proposed', 'countered')`, [buildingId], "ORDER BY updatedAt DESC, rowid DESC");
    const keyResults = this.keyResults(buildingId);
    return {
      goal: this.world.goalTree.purposeOf(b), keyResults, objectives: this.objectiveTree(buildingId, keyResults), blocked: this.blocked(b), stoplight: this.stoplight(b),
      grants: live.map((g) => this.view(g)), proposals: open.map((g) => this.view(g)), exploration: this.exploration(buildingId), directed: this.directed(buildingId),
    };
  }

  /** POST /api/buildings/:id/grants: a draft plan filed against a goal, with its own key results (`building.manage`). */
  create(actor: Actor, buildingId: string, input: CreateGrantInput): GrantView {
    const inp = CreateGrantInput.parse(input);
    this.world.buildings.require(buildingId, "building");
    if (actor) this.world.permissions.require(actor, "building.manage", buildingId);
    const goalId = this.requireGoal(buildingId, inp.goalId);
    const now = nowIso();
    const g = this.world.transaction(() => this.writeKeyResults(actor, this.world.grants.upsert({
      id: newId("gr"), buildingId, goalId, keyResultId: null, objective: inp.objective, approach: inp.approach, testingPlan: [],
      stopCondition: inp.stopCondition, askTokens: inp.askTokens,
      grantTokens: null, status: "draft", outcome: null, findingsDocIds: inp.findingsDocIds, picture: inp.picture ?? null, whatYoudSee: inp.whatYoudSee ?? "", checkpointsDone: [], checkpointDocId: null,
      proposedBy: actor?.id ?? "system", fundedBy: null, fundedWith: null, fundedAt: null, closedAt: null, history: [], createdAt: now, updatedAt: now,
    }), inp.keyResults));
    this.event("grant.created", g, actor, `Draft proposal: ${g.objective}`);
    return this.view(g);
  }

  /** PATCH /api/grants/:id while draft / countered (`building.manage`). `keyResults` replaces the grant's key results. */
  update(actor: Actor, id: string, input: UpdateGrantInput): GrantView {
    const { note, keyResults, goalId, ...fields } = UpdateGrantInput.parse(input);
    const g = this.world.grants.require(id, "grant");
    if (actor) this.world.permissions.require(actor, "building.manage", g.buildingId);
    this.requireStatus(g, ["draft", "countered"], "edited");
    const goal = goalId ? this.requireGoal(g.buildingId, goalId) : g.goalId;
    const next = this.world.transaction(() => {
      const history = g.status === "countered" ? [...g.history, this.entry(actor, "edit", fields.askTokens ?? null, note ?? "")] : g.history;
      const saved = this.world.grants.upsert({ ...g, ...fields, goalId: goal, history, updatedAt: nowIso() });
      if (keyResults) return this.writeKeyResults(actor, saved, keyResults);
      if (goal !== g.goalId) for (const k of this.keyResultsOf(g.id)) this.world.keyResults.upsert({ ...k, goalId: goal, updatedAt: nowIso() });
      return saved;
    });
    this.event("grant.updated", next, actor, `Proposal edited: ${next.objective}`);
    return this.view(next);
  }

  /**
   * A draft or countered grant's key results, replaced by `list` (1-5): each dated and checkable, under the grant's goal.
   * The first is the grant's `keyResultId`; work queued on the grant (never funded) follows it.
   */
  private writeKeyResults(actor: Actor, g: Grant, list: GrantKeyResultInput[]): Grant {
    const krs = list.map((k) => GrantKrInput.parse(k));
    if (!krs.length || krs.length > 5) throw badRequest("A grant carries 1-5 key results (text, howToCheck, due).");
    for (const k of this.keyResultsOf(g.id)) this.world.keyResults.delete(k.id);
    const by = actor ? holderOf(actor) : null;
    const now = nowIso();
    const last = this.world.keyResults.first("1 = 1", [], "ORDER BY position DESC");
    const ids = krs.map((k, i) => this.world.keyResults.upsert({
      id: newId("kr"), buildingId: g.buildingId, position: (last?.position ?? 0) + 1 + i, text: k.text, howToCheck: k.howToCheck,
      status: "not-started", statusNote: "", statusBy: null, createdBy: by?.id ?? null, editedBy: null, sourceDocIds: [], objectiveId: null,
      goalId: g.goalId, grantId: g.id, due: k.due ?? null, archivedAt: null, underReviewSince: null, postmortemDocId: null, updatedAt: now,
    }).id);
    for (const a of this.world.assignments.where("grantId = ? AND status IN ('pending', 'active') AND keyResultId IS NOT NULL", [g.id])) this.world.assignments.upsert({ ...a, keyResultId: ids[0]! });
    return this.world.grants.upsert({ ...g, keyResultId: ids[0]!, updatedAt: now });
  }

  /** The goal a grant is filed against: the building's goal or one under it (default the building's). */
  private requireGoal(buildingId: string, goalId: string | undefined): string {
    const at = this.world.goalTree.attachmentOf(buildingId);
    if (!goalId) return at;
    if (!this.world.goalTree.scopeOf(buildingId).has(goalId)) throw badRequest(`Goal ${goalId} is not ${buildingId}'s goal or under it: file the grant against goal ${at} or one of its children.`);
    return goalId;
  }

  /** draft / countered → proposed (`building.manage`). Several can be open per building, each decided on its own. Tells the humans who can fund. */
  propose(actor: Actor, id: string, note = ""): GrantView {
    const g = this.world.grants.require(id, "grant");
    if (actor) this.world.permissions.require(actor, "building.manage", g.buildingId);
    this.requireStatus(g, ["draft", "countered"], "proposed");
    if (!this.keyResultsOf(g.id).length) throw badRequest("A grant carries 1-5 key results: give keyResults (text, howToCheck, due) first.");
    const next = this.save(g, actor, { status: "proposed" }, "propose", g.askTokens, note);
    this.event("grant.proposed", next, actor, `Proposal: ${next.objective} (${fmt(next.askTokens)} tokens)`);
    this.notifyFunders(next, actor, `${this.world.nameOf(next.proposedBy)} proposed "${next.objective}" for ${fmt(next.askTokens)} tokens. Fund, counter or reject it on the board.`);
    return this.view(next);
  }

  /**
   * POST /api/grants/:id/decide (`building.fund`). Proposed: fund (tokens default to the ask) / counter (edits + note,
   * back to the manager) / reject. Checkpoint: continue / adjust (tokens, stop condition) / cut.
   * Member funding: `fund` with `fundWith` (one of the funder's own Bank inputs) needs no `building.fund`, only a human
   * whose active input can still pay the grant's tokens; its sessions are then paid from that input first.
   */
  decide(actor: Actor, id: string, input: DecideGrantInput): GrantView {
    const inp = DecideGrantInput.parse(input);
    const g = this.world.grants.require(id, "grant");
    if (inp.fundWith && inp.action !== "fund") throw badRequest("fundWith goes with action \"fund\" only.");
    const tokens = inp.tokens ?? g.askTokens;
    if (inp.fundWith) this.requireFundingInput(actor, g, inp.fundWith, tokens);
    else if (actor && !this.canFund(actor, g)) throw forbidden("building.fund");
    const spent = this.spent(g.id);
    // decided on a review-deck slide: the event says which
    const deck = inp.deckSlide ? { deckSlide: inp.deckSlide } : {};
    const edits = { ...(inp.stopCondition && { stopCondition: inp.stopCondition }) };
    let next: Grant;
    switch (inp.action) {
      case "fund": {
        this.requireStatus(g, ["proposed"], "funded");
        if (!this.keyResultsOf(g.id).length) throw badRequest("This grant carries no key results: counter it so the manager adds them.");
        const fundedWith = inp.fundWith ?? null;
        next = this.save(g, actor, { ...edits, status: "funded", grantTokens: tokens, checkpointsDone: passed(spent, tokens), fundedBy: actor ? holderOf(actor).id : "system", fundedWith, fundedAt: nowIso() }, "fund", tokens, inp.note);
        const from = fundedWith ? ` funded from ${this.world.bank.input(fundedWith)?.label ?? fundedWith}` : "";
        this.event("grant.funded", next, actor, `Funded: ${next.objective} (${fmt(tokens)} tokens${from})`, deck);
        this.decisionAssignment(next, actor, "funded", inp.note);
        break;
      }
      case "counter": {
        this.requireStatus(g, ["proposed"], "countered");
        if (!inp.note.trim()) throw badRequest("A counter needs a note saying what to change.");
        next = this.save(g, actor, { ...edits, status: "countered", ...(inp.tokens && { askTokens: inp.tokens }) }, "counter", inp.tokens ?? null, inp.note);
        this.event("grant.countered", next, actor, `Countered: ${next.objective}`, deck);
        this.notifyManager(next, actor, `A human countered your proposal "${next.objective}": ${inp.note}`);
        this.decisionAssignment(next, actor, "countered", inp.note);
        break;
      }
      case "reject":
        this.requireStatus(g, ["proposed"], "rejected");
        next = this.save(g, actor, { status: "rejected", closedAt: nowIso() }, "reject", null, inp.note);
        // a rejected proposal's key results archive with it (goals keep no open ones)
        for (const k of this.keyResultsOf(g.id).filter(isOpenKr)) this.world.keyResults.upsert({ ...k, archivedAt: nowIso(), statusNote: `grant ${g.id} rejected`, updatedAt: nowIso() });
        this.event("grant.rejected", next, actor, `Rejected: ${next.objective}`, deck);
        this.notifyManager(next, actor, `A human rejected your proposal "${next.objective}"${inp.note ? `: ${inp.note}` : "."}`);
        this.decisionAssignment(next, actor, "rejected", inp.note);
        break;
      case "continue":
        this.requireStatus(g, ["checkpoint"], "continued");
        if (spent >= (g.grantTokens ?? 0)) throw new AppError("conflict", "The grant is fully spent: top it up (adjust with more tokens) or cut it.");
        next = this.save(g, actor, { status: "funded" }, "continue", null, inp.note);
        this.event("grant.funded", next, actor, `Continued: ${next.objective}`, deck);
        break;
      case "adjust": {
        this.requireStatus(g, ["checkpoint"], "adjusted");
        const tokens = inp.tokens ?? g.grantTokens ?? 0;
        if (tokens <= spent) throw badRequest(`The grant has spent ${fmt(spent)} tokens: an adjusted grant must be more than that.`);
        const checkpointsDone = tokens === g.grantTokens ? g.checkpointsDone : passed(spent, tokens);
        next = this.save(g, actor, { ...edits, status: "funded", grantTokens: tokens, checkpointsDone }, "adjust", tokens, inp.note);
        this.event("grant.funded", next, actor, `Adjusted: ${next.objective} (${fmt(tokens)} tokens)`, deck);
        break;
      }
      case "cut":
        this.requireStatus(g, ["checkpoint"], "cut");
        next = this.save(g, actor, { status: "closed", outcome: "cut", closedAt: nowIso() }, "cut", null, inp.note);
        this.event("grant.closed", next, actor, `Cut: ${next.objective}`, deck);
        this.notifyManager(next, actor, `A human cut the grant "${next.objective}" at its checkpoint${inp.note ? `: ${inp.note}` : "."}`);
        break;
    }
    return this.view(next);
  }

  /**
   * Member funding's gate: the funder is a human (an avatar counts as its user), the input is theirs and active, and it
   * can still pay `tokens` after what it already owes the other live grants it pays for. Nothing is reserved.
   */
  private requireFundingInput(actor: Actor, g: Grant, inputId: string, tokens: number): void {
    const by = actor ? holderOf(actor) : null;
    if (by && by.kind !== "user") throw forbidden("building.fund", "Only a human can fund a grant with a Bank input.");
    const inp = this.world.bank.input(inputId);
    if (!inp) throw notFound("bank input", inputId);
    if (by && inp.userId !== by.id) throw forbidden("building.fund", `${inp.label} is not your Bank input: fund with one of your own.`);
    if (inp.cancelledAt) throw badRequest(`${inp.label} is cancelled: fund with an active input.`);
    const owed = this.world.grants.where("fundedWith = ? AND status IN ('funded', 'checkpoint') AND id != ?", [inputId, g.id])
      .reduce((s, x) => s + Math.max(0, (x.grantTokens ?? 0) - this.spent(x.id)), 0);
    const can = this.world.bank.inputBalance(inputId) - owed;
    if (can < tokens) {
      throw badRequest(`${inp.label} can pay ${fmt(Math.max(0, can))} more tokens${owed ? ` (after ${fmt(owed)} it owes other grants)` : ""}; this grant needs ${fmt(tokens)}. Fund fewer tokens or use another input.`);
    }
  }

  /** POST /api/grants/:id/close: the manager may close (or withdraw) as `stopped`, or as `done` (closeDone); `building.fund` any outcome. */
  close(actor: Actor, id: string, input: CloseGrantInput): GrantView {
    const inp = CloseGrantInput.parse(input);
    if (inp.outcome === "done") return this.closeDone(actor, id, { note: inp.note });
    const g = this.world.grants.require(id, "grant");
    if (actor && !this.canFund(actor, g)) {
      if (inp.outcome !== "stopped") throw forbidden("building.fund", `Only a human who can fund this building can close a grant as "${inp.outcome}"; a manager can close it as "stopped".`);
      this.world.permissions.require(actor, "building.manage", g.buildingId);
    }
    if (TERMINAL.includes(g.status)) throw new AppError("conflict", `This grant is already ${g.status}.`);
    if (!LIVE.includes(g.status) && inp.outcome !== "stopped") throw badRequest(`A ${g.status} proposal can only be withdrawn (outcome "stopped").`);
    const next = this.save(g, actor, { status: "closed", outcome: inp.outcome, closedAt: nowIso() }, "close", null, inp.note);
    this.event("grant.closed", next, actor, `Closed (${inp.outcome}): ${next.objective}`);
    return this.view(next);
  }

  /**
   * The manager's `close_grant` (and POST /api/grants/:id/close with outcome "done"): the work is done before the grant is spent, so the manager
   * closes a funded (or checkpoint) grant as `closed`, outcome `done`, and claims its open key results with the note as evidence
   * (Mitchell, town hall mt_6830h8x5qk decision 3). The unspent rest goes back to the Bank by construction: reservations
   * only count live grants. The grant then waits in the Town Hall in-tray until a human marks each key result met or missed.
   * `reportId` links the close report (`checkpointDocId`); without it the manager's next rollup this session links itself.
   */
  closeDone(actor: Actor, grantId: string, input: { note: string; reportId?: string | null }): GrantView {
    const g = this.world.grants.require(grantId, "grant");
    // the manager (close_grant) or a human who can fund the building (the web "Close grant" button)
    if (actor && !this.world.permissions.can(actor, "building.manage", g.buildingId) && !this.canFund(actor, g)) throw forbidden("building.manage");
    if (TERMINAL.includes(g.status)) throw new AppError("conflict", `This grant is already ${g.status}.`);
    this.requireStatus(g, LIVE, "closed as done");
    // a human may leave the note blank (Mitchell, 1:1 mt_kdsxeqo6ot): the key result's claimed note still names who closed it
    const human = actor?.kind === "human";
    const note = (input.note ?? "").trim() || (human ? `Closed as done by ${this.world.nameOf(actor.id)} from the Town Hall.` : "");
    if (!note) throw badRequest("Give the evidence that the work is done (note).");
    if (input.reportId) {
      const d = this.world.docs.get(input.reportId);
      if (!d || d.type !== "report" || d.buildingId !== g.buildingId) throw badRequest(`${input.reportId} is not a report of this building.`);
    }
    const grantTokens = g.grantTokens ?? 0;
    const spentTokens = this.spent(g.id);
    const unspentTokens = Math.max(0, grantTokens - spentTokens);
    const returned = `returned ${fmt(unspentTokens)} unspent tokens to the Bank`;
    return this.world.transaction(() => {
      const next = this.save(g, actor, { status: "closed", outcome: "done", closedAt: nowIso(), ...(input.reportId && { checkpointDocId: input.reportId }) }, "close", unspentTokens,
        `${note} (spent ${fmt(spentTokens)} of ${fmt(grantTokens)}; ${returned})`);
      for (const k of this.keyResultsOf(g.id).filter(isOpenKr)) this.updateKeyResult(actor, k.id, { status: "claimed", note });
      this.event("grant.closed", next, actor, `Closed (done): ${next.objective}; ${returned}`, { outcome: "done", spentTokens, grantTokens, unspentTokens });
      this.notifyFunders(next, actor, `${human ? this.world.nameOf(actor.id) : "The manager"} closed the grant "${next.objective}" as done: ${note} It spent ${fmt(spentTokens)} of ${fmt(grantTokens)} tokens and ${returned}. Mark each of its key results met or missed in the Town Hall in-tray.`);
      return this.view(next);
    });
  }

  /**
   * After a charge (`Budget.afterCharge`): every funded grant of the building whose derived spend crossed a checkpoint
   * fraction (100%) not yet done goes to `checkpoint`: new sessions on it are held, `grant.checkpoint` is appended,
   * the humans who can fund are told, and the building's manager agent gets the checkpoint assignment (lane grant, which
   * runs while the grant is at checkpoint). Each fraction fires once per grantTokens value. Returns the grants it held.
   */
  checkpoints(buildingId: string): Grant[] {
    const held: Grant[] = [];
    for (const g of this.world.grants.where("buildingId = ? AND status = 'funded'", [buildingId])) {
      const tokens = g.grantTokens ?? 0;
      const spent = this.spent(g.id);
      const crossed = passed(spent, tokens).filter((f) => !g.checkpointsDone.includes(f));
      if (!tokens || !crossed.length) continue;
      const pct = Math.round((spent / tokens) * 100);
      const at = Math.max(...crossed);
      const next = this.world.transaction(() => {
        const next = this.save(g, null, { status: "checkpoint", checkpointsDone: [...g.checkpointsDone, ...crossed].sort() }, "checkpoint", spent,
          `Spend crossed ${at * 100}% (${fmt(spent)} of ${fmt(tokens)} tokens, ${pct}%): new sessions on it are held until a human decides.`);
        this.checkpointAssignment(next, spent, at);
        return next;
      });
      this.world.events.append({ type: "grant.checkpoint", buildingId, text: `Checkpoint at ${at * 100}%: ${g.objective} (${fmt(spent)} / ${fmt(tokens)} tokens)`, payload: { grantId: g.id, status: next.status, fraction: at, spentTokens: spent, grantTokens: tokens } });
      this.notifyFunders(next, null, `"${g.objective}" crossed ${at * 100}% of its ${fmt(tokens)}-token grant (${fmt(spent)} spent): its sessions are held. The manager is writing the checkpoint; continue, adjust or cut it in the Town Hall in-tray.`);
      held.push(next);
    }
    return held;
  }

  /**
   * Boot repair: a grant still held at the retired 50% checkpoint (status checkpoint, spend under its tokens, the 100%
   * one not done) goes back to funded so its grant-lane work starts without a human continue. Idempotent; a grant a
   * human already continued or adjusted is funded and untouched. Returns the grants it released.
   */
  releaseHalfway(): Grant[] {
    const released: Grant[] = [];
    for (const g of this.world.grants.where("status = 'checkpoint'", [])) {
      const tokens = g.grantTokens ?? 0;
      if (g.checkpointsDone.includes(1) || !tokens || this.spent(g.id) >= tokens) continue;
      const next = this.save(g, null, { status: "funded" }, "continue", null, "The 50% checkpoint was removed: a grant runs to its full number and is held only at 100%.");
      this.event("grant.funded", next, null, `Released from the 50% checkpoint: ${next.objective}`);
      released.push(next);
    }
    return released;
  }

  /** The manager's "Write the checkpoint for …" assignment (none when the building has no manager agent: humans decide from the in-tray). */
  private checkpointAssignment(g: Grant, spent: number, at: number): void {
    const building = this.world.buildings.require(g.buildingId, "building");
    const manager = managerAgentOf(this.world, building);
    if (!manager) return;
    const krs = this.krLines(g);
    const reports = this.world.assignments.where("grantId = ? AND reportId IS NOT NULL", [g.id], "ORDER BY updatedAt").map((a) => a.reportId!);
    createAssignment(this.world, {
      agentId: manager.id, buildingId: g.buildingId, front: true, createdBy: { kind: "system", id: "system" },
      laneOverride: { lane: "grant", grantId: g.id, keyResultId: null, gap: null, sourceId: null },
      title: `Write the checkpoint for ${g.objective}`.slice(0, 160),
      description: `Grant ${g.id} "${g.objective}" crossed ${at * 100}% of its tokens: ${fmt(spent)} of ${fmt(g.grantTokens ?? 0)} spent. New sessions on it are held until a human continues, adjusts or cuts it in the Town Hall in-tray; this assignment runs anyway, charged to the grant.

Write the checkpoint for ${g.objective}: each key result's status with evidence a human can check in the live town (its how-to-check says how), spend so far, and whether to continue.

Key results (the grant's own):
${krs}

Stop condition: ${g.stopCondition}

1. \`checkpoint_grant\` with grantId ${g.id}, a status (not-started, on-track, at-risk or claimed; only a human marks met or missed) and a note with the evidence: for all its open key results, or one at a time with keyResultId.
2. \`submit_report\` with \`rollup: true\` as your checkpoint report (it lands in the Town Hall in-tray and is linked to the grant). The usual rollup format (the four sections; Shipped items with **What it is:**, **What you'd see:** and **Your call:**); Key results carries each of the grant's key results, its status, how to check it and what the check showed, ${fmt(spent)} / ${fmt(g.grantTokens ?? 0)} tokens; Needs from Mitchell asks to continue, adjust or cut, and why. Put the reports the grant's work produced in provenance.sourceIds${reports.length ? `: ${reports.join(", ")}` : " (none yet; leave it empty)"}.`,
    });
  }

  /**
   * A human's decision on a proposal wakes the manager the way a reply to a report does (Mitchell, 1:1 mt_f45m8hbmct):
   * one front-of-queue assignment, the same hook as the checkpoint one. Funded → lane grant on the grant ("assign its
   * first step or take it yourself", the plan in the description); countered → directed ("Answer the counter", with the
   * note); rejected → directed ("read the note"). None when the building has no manager agent: a human works its in-tray.
   */
  private decisionAssignment(g: Grant, actor: Actor, decision: "funded" | "countered" | "rejected", note: string): void {
    const building = this.world.buildings.require(g.buildingId, "building");
    const manager = managerAgentOf(this.world, building);
    if (!manager) return;
    const who = actor?.kind === "human" ? this.world.nameOf(actor.id) : "A human";
    const krs = this.krLines(g);
    const said = note.trim() ? `\n\nThe note: ${note.trim()}` : "";
    const base = { agentId: manager.id, buildingId: g.buildingId, front: true, createdBy: { kind: "system" as const, id: "system" } };
    if (decision === "funded") {
      createAssignment(this.world, {
        ...base, laneOverride: { lane: "grant", grantId: g.id, keyResultId: g.keyResultId, gap: null, sourceId: null },
        title: `Grant ${g.id} funded: assign its first step or take it yourself`.slice(0, 160),
        description: `${who} funded grant ${g.id} "${g.objective}" with ${fmt(g.grantTokens ?? 0)} tokens.${said}

Nothing starts by itself: funding runs the plan only once its steps are assignments. This session is charged to the grant.

The plan (the grant page ${g.id} has the history):
Key results (the grant's own):
${krs}
Approach: ${g.approach || "(none written)"}
Stop condition: ${g.stopCondition}${g.findingsDocIds.length ? `\nFindings it draws on: ${g.findingsDocIds.join(", ")}` : ""}

1. Cut the plan into steps, each one session's worth with a check a human can make in the live town.
2. \`assign\` the first step in lane grant with grantId ${g.id}: with no agentId (the building queue; a fork runs it), attaching the topic pages that cover it (pages, at most 3), or to yourself when it is yours (one owner per step). Sessions on it are charged to the grant and held at its 100% checkpoint.
3. Say in your report who got what and what the next step is.`,
      });
    } else if (decision === "countered") {
      createAssignment(this.world, {
        ...base, laneOverride: DIRECTED,
        title: `Answer the counter on ${g.objective}`.slice(0, 160),
        description: `${who} countered your proposal ${g.id} "${g.objective}" (ask now ${fmt(g.askTokens)} tokens).${said}

It is your move: nothing on it runs until this is settled.
Key results (the grant's own):
${krs}

1. Read the note and the proposal (${g.id}: objective, key results, approach, stop condition, ask).
2. Revise what the note asks for and re-propose it with \`propose_grant\` and grantId ${g.id} (the revised plan, key results included, rewrites this proposal under the same id and sends it back to the Town Hall in-tray; your other open proposals are untouched); or, if the counter means the plan is wrong, withdraw it and say what you'd propose instead.
3. Say in your report what changed and why.`,
      });
    } else {
      createAssignment(this.world, {
        ...base, laneOverride: DIRECTED,
        title: `Grant ${g.id} rejected: read the note`.slice(0, 160),
        description: `${who} rejected your proposal ${g.id} "${g.objective}" (${fmt(g.askTokens)} tokens asked).${said || "\n\nNo note was given."}

Its key results (they close with it):
${krs}

1. Read the note and the proposal (${g.id}).
2. Decide what follows: a different plan (\`propose_grant\` with its own key results), exploration first (\`assign\` lane exploration with a gap), or nothing until your next 1:1 or rollup.
3. Say in your report what you decided and why.`,
      });
    }
  }

  /**
   * \`checkpoint_grant\` (the manager, \`building.manage\`): set the status of the grant's open key results, or one (up to \`claimed\`) and
   * link the checkpoint report (\`reportId\`, else the rollup this session submits links itself). The grant stays at checkpoint.
   * A funded grant whose checkpoint already fired is accepted too: a human may adjust (top up) or continue it from the in-tray before
   * the manager's checkpoint session files (gr_iq5m7dug56, 2026-10-26: continued 4 min after the 50% hold).
   */
  fileCheckpoint(actor: Actor, grantId: string, input: { reportId?: string | null; status?: KeyResult["status"] | null; note?: string; keyResultId?: string | null }): GrantView {
    const g = this.world.grants.require(grantId, "grant");
    if (actor && !this.world.permissions.can(actor, "building.manage", g.buildingId)) throw forbidden("building.manage");
    if (!(g.status === "funded" && g.history.some((h) => h.action === "checkpoint"))) this.requireStatus(g, ["checkpoint"], "checkpointed");
    if (input.status === "met" || input.status === "missed") throw badRequest(`Only a human marks a key result ${input.status}; claim it instead.`);
    const open = this.keyResultsOf(g.id).filter(isOpenKr);
    const targets = input.keyResultId ? open.filter((k) => k.id === input.keyResultId) : open;
    if (input.keyResultId && !targets.length) throw badRequest(`${input.keyResultId} is not an open key result of grant ${g.id}.`);
    if (input.status && !targets.length) throw badRequest("This grant has no open key result, so there is no status to set.");
    if (input.reportId) {
      const d = this.world.docs.get(input.reportId);
      if (!d || d.type !== "report" || d.buildingId !== g.buildingId) throw badRequest(`${input.reportId} is not a report of this building.`);
    }
    return this.world.transaction(() => {
      if (input.status) for (const k of targets) this.updateKeyResult(actor, k.id, { status: input.status, note: input.note ?? "" });
      if (input.reportId) this.world.grants.upsert({ ...this.world.grants.require(g.id), checkpointDocId: input.reportId, updatedAt: nowIso() });
      return this.get(g.id);
    });
  }

  /** DELETE /api/key-results/:id (a human with `building.manage`). Refused while an open or live grant names it. */
  deleteKeyResult(actor: Actor, id: string): void {
    const kr = this.world.keyResults.require(id, "key result");
    this.requireHuman(actor, kr.buildingId, "deletes");
    const g = kr.grantId ? this.world.grants.get(kr.grantId) : undefined;
    if (g && !TERMINAL.includes(g.status)) throw new AppError("conflict", `Grant ${g.id} ("${g.objective}", ${g.status}) carries this key result: edit the proposal's key results or close the grant first.`);
    this.world.keyResults.delete(id);
    this.world.events.append({ type: "kr.deleted", agentId: actor?.id ?? null, buildingId: kr.buildingId, text: `Key result removed: ${kr.text}`, payload: { keyResultId: id } });
  }

  /**
   * PATCH /api/key-results/:id. `status`: the manager up to `claimed`; `met` /
   * `missed` (and undoing them) need `building.fund`. `text` / `howToCheck` / `sourceDocIds`: a human with
   * `building.manage`, or the building's own manager agent.
   */
  updateKeyResult(actor: Actor, id: string, input: UpdateKeyResultInput): KeyResult {
    const inp = UpdateKeyResultInput.parse(input);
    const kr = this.world.keyResults.require(id, "key result");
    const words = {
      ...(inp.text !== undefined && { text: inp.text }), ...(inp.howToCheck !== undefined && { howToCheck: inp.howToCheck }),
      ...(inp.sourceDocIds !== undefined && { sourceDocIds: inp.sourceDocIds }), ...(inp.due !== undefined && { due: inp.due }),
    };
    const edited = Object.keys(words).length > 0;
    const moved = inp.objectiveId !== undefined && inp.objectiveId !== kr.objectiveId;
    if (!inp.status && !edited && !moved) throw badRequest("Nothing to change: give status, text, howToCheck, sourceDocIds or objectiveId.");
    // re-marking the current status with no new note changes nothing: no write, no kr.updated, no manager wake
    if (inp.status === kr.status && !edited && !moved && (!inp.note.trim() || inp.note === kr.statusNote)) return kr;
    if (edited || moved) {
      this.requireWriter(actor, this.world.buildings.require(kr.buildingId, "building"));
      if (inp.sourceDocIds) this.requireSources(inp.sourceDocIds);
      if (moved && inp.objectiveId) this.requireObjectiveRoom(kr.buildingId, inp.objectiveId, kr.id);
    }
    if (actor && inp.status) {
      const judged = inp.status === "met" || inp.status === "missed" || kr.status === "met" || kr.status === "missed";
      // a human who can fund the building, or the owner of the key result's goal (docs/goals.md "Captains on nodes")
      if (judged) {
        if (!this.world.permissions.can(actor, "building.fund", kr.buildingId) && !(kr.goalId && this.world.goalTree.owns(actor, kr.goalId))) throw forbidden("building.fund");
      } else if (!this.canManage(actor, kr.buildingId)) throw forbidden("building.manage");
      // a human marking it missed says why: the line is the postmortem's source (docs/goals.md "Postmortems on missed KRs")
      if (inp.status === "missed" && kr.status !== "missed" && actor.kind === "human" && !inp.note.trim()) throw badRequest("Say why it was missed (note): the line files the postmortem's source.");
    }
    const by = actor ? holderOf(actor) : null;
    const now = nowIso();
    // met or missed archives it under its goal (the goal stays); undoing that brings it back
    const archive = inp.status ? { archivedAt: inp.status === "met" || inp.status === "missed" ? kr.archivedAt ?? now : null } : {};
    const status = inp.status ? { status: inp.status, statusNote: inp.note, statusBy: by?.id ?? "system", ...archive } : {};
    const tree = moved ? { objectiveId: inp.objectiveId ?? null, goalId: inp.objectiveId ?? this.world.goalTree.attachmentOf(kr.buildingId) } : {};
    const next = this.world.keyResults.upsert({ ...kr, ...words, ...(edited && { editedBy: by?.id ?? null }), ...tree, ...status, updatedAt: now });
    if (inp.status === "missed" && kr.status !== "missed") queuePostmortem(this.world, actor, next, inp.note);
    this.world.events.append({
      type: "kr.updated", agentId: actor?.id ?? null, buildingId: kr.buildingId, text: inp.status ? `Key result ${inp.status}: ${next.text}` : edited ? `Key result edited: ${next.text}` : `Key result moved: ${next.text}`,
      payload: {
        grantId: kr.grantId, keyResultId: kr.id, status: next.status, from: kr.status,
        by: by?.id ?? "system", byKind: by?.kind ?? "system", edited, ...(moved && { objectiveId: next.objectiveId, fromObjectiveId: kr.objectiveId }),
        ...(edited && { text: next.text, howToCheck: next.howToCheck, sourceDocIds: next.sourceDocIds, fromText: kr.text }),
      },
    });
    return next;
  }

  // ---- helpers ----
  /** A grant's key results as brief lines: id, status, words, how to check, due. */
  private krLines(g: Grant): string {
    const krs = this.keyResultsOf(g.id);
    return krs.length ? krs.map((k) => `- ${k.id} [${k.status}] ${k.text} (how to check: ${k.howToCheck}${k.due ? `; due ${k.due}` : ""})`).join("\n") : "(none)";
  }

  /** A human with `building.manage`, or the building's own manager agent, writes the goal's key results. */
  private requireWriter(actor: Actor, b: Building, what = "key results"): void {
    if (!actor) return;
    if (actor.kind !== "human") {
      if (b.managerAgentId === actor.id && b.kind !== "town-hall") return;
      throw forbidden("building.manage", `Only a human or ${b.name}'s manager writes its goal's ${what}.`);
    }
    this.world.permissions.require(actor, "building.manage", b.id);
  }

  /** Only a human (`building.manage`) deletes a key result. */
  private requireHuman(actor: Actor, buildingId: string, verb: string): void {
    if (!actor) return;
    if (actor.kind !== "human") throw forbidden("building.manage", `Only a human ${verb} a grant's key result.`);
    this.world.permissions.require(actor, "building.manage", buildingId);
  }

  /** A key result's sources are published docs (meeting notes, reports), not drafts. */
  private requireSources(ids: string[]): void {
    for (const id of ids) {
      const d = this.world.docs.get(id);
      if (!d || d.state === "draft") throw badRequest(`Source ${id} is not a published document (meeting notes or a report).`);
    }
  }

  /** Who decides a grant: a human with `building.fund` on its building, or the captain of its goal (docs/goals.md "Captains on nodes"). */
  canFund(actor: Actor, g: Grant): boolean {
    if (!actor || this.world.permissions.can(actor, "building.fund", g.buildingId)) return true;
    const goalId = g.goalId ?? (g.keyResultId ? this.world.keyResults.get(g.keyResultId)?.goalId : null);
    return !!goalId && this.world.goalTree.owns(actor, goalId);
  }

  private requireStatus(g: Grant, ok: GrantStatus[], verb: string): void {
    if (!ok.includes(g.status)) throw new AppError("conflict", `A ${g.status} grant can't be ${verb} (needs ${ok.join(" or ")}).`);
  }

  private entry(actor: Actor, action: GrantHistoryEntry["action"], tokens: number | null, note: string): GrantHistoryEntry {
    const by = actor ? holderOf(actor) : { kind: "user" as const, id: "system" };
    return { at: nowIso(), byId: by.id, byKind: by.kind === "user" ? "user" : "agent", action, tokens, note };
  }

  private save(g: Grant, actor: Actor, patch: Partial<Grant>, action: GrantHistoryEntry["action"], tokens: number | null, note: string): Grant {
    return this.world.grants.upsert({ ...g, ...patch, history: [...g.history, this.entry(actor, action, tokens, note)], updatedAt: nowIso() });
  }

  private event(type: EventType, g: Grant, actor: Actor, text: string, extra: Record<string, unknown> = {}): void {
    // action: the history entry that made it (fund, continue, adjust, cut, close…); the manager in-tray rule reads it (core/src/wakes.ts)
    const action = g.history.at(-1)?.action ?? null;
    this.world.events.append({ type, agentId: actor?.id ?? null, buildingId: g.buildingId, text, payload: { grantId: g.id, status: g.status, action, ...extra } });
  }

  /** Inbox note to every human (avatar) who can fund the building. */
  private notifyFunders(g: Grant, actor: Actor, body: string): void {
    const from = actor ? holderOf(actor) : { kind: "system" as const, id: "system" };
    for (const h of this.world.agents.where("kind = 'human' AND status != 'retired'")) {
      if (h.id === actor?.id || !this.canFund(h, g)) continue;
      sendMessage(this.world, { kind: "system", fromId: from.id, fromKind: from.kind, toId: h.id, body });
    }
  }

  private notifyManager(g: Grant, actor: Actor, body: string): void {
    if (!this.world.agents.get(g.proposedBy)) return;
    const from = actor ? holderOf(actor) : { kind: "system" as const, id: "system" };
    sendMessage(this.world, { kind: "system", fromId: from.id, fromKind: from.kind, toId: g.proposedBy, body });
  }
}

/** Checkpoint fractions already behind a grant of `tokens` with `spent` so far (they won't fire again). */
function passed(spent: number, tokens: number): number[] {
  return CHECKPOINTS.filter((f) => spent >= f * tokens);
}

const fmt = (n: number) => n.toLocaleString("en-US");
