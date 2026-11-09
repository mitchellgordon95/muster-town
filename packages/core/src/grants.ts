import {
  type GrantEstimate, CloseGrantInput, CreateGrantInput, CreateObjectiveInput, DecideGrantInput, MAX_KEY_RESULTS_PER_OBJECTIVE, MAX_OBJECTIVES,
  StepSize, StopGrantInput, UpdateGrantInput, grantPricingOf, UpdateKeyResultInput, type GrantKeyResultInput, UpdateObjectiveInput, type KpiKey, type Objective, type CheckpointEvidence, type ReportKrEvidence, type ReportTopUp, krVerdict, parseRollup,
  type Assignment, type Building, type Event, type Grant, type GrantHistoryEntry, type GrantStep, type GrantStepState, type GrantStatus, type GrantView, type KeyResult, type Session, type Stoplight, type TokenCounts, ZERO_TOKENS, addTokens, stoplightOf, GrantKeyResultInput as GrantKrInput,
} from "@muster-town/schema";
import { askAtCheckpoint, onGrantEvent, retireAsks } from "./asks.ts";
import { closedLoopNotice, verifiedNotice } from "./notices.ts";
import { sessionTokens } from "./bank.ts";
import { createAssignment, managerAgentOf, sendMessage, setAssignmentStatus } from "./domain.ts";
import { checkForkModel, interruptFork } from "./forks.ts";
import { attachablePages } from "./schedules.ts";
import type { EventType } from "./events.ts";
import { AppError, badRequest, forbidden, notFound } from "./errors.ts";
import type { Actor } from "./ops.ts";
import { intrayRow } from "./wakes.ts";
import { freeTokens, goalFunding, grantGoalOf } from "./free-tokens.ts";
import { estimateGrant, estimateVsActual, type EstimateVsActual } from "./grant-estimate.ts";
import { holderOf } from "./permissions.ts";
import { queuePostmortem } from "./postmortems.ts";
import { whereOf } from "./table.ts";
import { newId, nowIso } from "./util.ts";
import type { World } from "./world.ts";

/**
 * The hold of a funded grant, as `checkpointsDone` records it: 1 = the hold at the ceiling. T&M with a ceiling
 * (docs/legible-delegation.md §7.3): the grant runs to its grantTokens and holds there, and only there; sessions already
 * running at the hold finish and book. The retired reserve hold (0, at grantTokens − min(150k, a third)) and 50% one
 * (0.5) may remain in old rows; `releaseHalfway` frees the latter.
 */
export const CHECKPOINTS = [1] as const;
const HOLD_RESERVE = 0;
const HOLD_FULL = 1;

/** A funded grant's hold point: its ceiling, grantTokens; null when the hold already fired for it or the grant has no tokens. */
function holdAtTokens(g: Pick<Grant, "grantTokens" | "checkpointsDone">): number | null {
  const tokens = g.grantTokens ?? 0;
  return !tokens || g.checkpointsDone.includes(HOLD_FULL) ? null : tokens;
}

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
/** A decision a human said in a 1:1 and its agent did for them (act_in_1on1): recorded on the history entry. */
interface DecidedVia { agentId: string; meetingId: string }
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
    return sessions.reduce((s, x) => s + sessionTokens(x), 0);
  }

  view(g: Grant): GrantView {
    const sessions = this.world.sessions.where("grantId = ?", [g.id]);
    const spentCounts = sessions.reduce<TokenCounts>((s, x) => addTokens(s, x), { ...ZERO_TOKENS });
    return {
      ...g, keyResult: (g.keyResultId && this.world.keyResults.get(g.keyResultId)) || null, keyResults: this.keyResultsOf(g.id), spentTokens: this.adjustedSum(sessions), spentCounts,
      fundedByName: g.fundedBy ? this.world.nameOf(g.fundedBy) : null, fundedWithLabel: g.fundedWith ? this.world.bank.input(g.fundedWith)?.label ?? null : null,
      holdAtTokens: g.status === "funded" ? holdAtTokens(g) : null,
      evidence: this.evidenceFor(g), stepStates: this.stepStates(g),
    };
  }

  /** Per step of the plan, its latest assignment (`grantStep`): queued, running, done or cancelled; null while none was queued. */
  stepStates(g: Grant): (GrantStepState | null)[] {
    if (!g.steps.length) return [];
    const out: (GrantStepState | null)[] = g.steps.map(() => null);
    for (const a of this.world.assignments.where("grantId = ? AND grantStep IS NOT NULL", [g.id], "ORDER BY createdAt, rowid")) {
      if (a.grantStep! < out.length) out[a.grantStep!] = { assignmentId: a.id, status: a.status, reportId: a.reportId };
    }
    return out;
  }

  /**
   * What a checkpoint card shows (Mitchell 1:1 mt_7b4zc7yja3): a checkpoint grant's own evidence; on a proposal, the
   * evidence of the earlier grant it names in `continues` (1:1 mt_z1b38bwg98: never guessed from the goal, which put an
   * unrelated grant's checkpoint on a card). Null otherwise.
   */
  private evidenceFor(g: Grant): CheckpointEvidence | null {
    if (g.status === "checkpoint") return this.evidence(g);
    if (g.status !== "proposed" && g.status !== "countered") return null;
    const prior = g.continues ? this.world.grants.get(g.continues) : undefined;
    return prior && prior.buildingId === g.buildingId ? this.evidence(prior) : null;
  }

  /** A proposal's `continues`: an earlier grant of the same building, not itself. */
  private requireContinues(buildingId: string, id: string | null | undefined, self?: string): string | null {
    if (!id) return null;
    const p = this.world.grants.get(id);
    if (!p || p.buildingId !== buildingId || p.id === self) throw badRequest(`continues: ${id} is not an earlier grant of your building.`);
    return p.id;
  }

  /**
   * One grant's checkpoint evidence (grant C, gr_95svkzi4l6: it assembles itself, no manager session): per key result its
   * verdict, the latest note and who set it (the forks file it with `submit_report`), spend, the latest top-up line a fork
   * filed, the grant's own reports, and a close report's Shipped titles. `filed` is false when no agent set a key result.
   */
  evidence(g: Grant): CheckpointEvidence {
    const report = g.checkpointDocId ? this.world.docs.get(g.checkpointDocId) : undefined;
    const krs = this.keyResultsOf(g.id);
    const reportIds = [...new Set(this.world.sessions.where("grantId = ? AND reportId IS NOT NULL", [g.id], "ORDER BY startedAt, rowid").map((x) => x.reportId!))];
    const reports = reportIds.flatMap((id) => {
      const d = this.world.docs.get(id);
      return d ? [{ id: d.id, title: d.title, authorName: this.world.nameOf(d.authorId), verdict: d.verdict ?? null, at: d.createdAt }] : [];
    });
    return {
      grantId: g.id, objective: g.objective,
      keyResults: krs.map((k) => ({ id: k.id, text: k.text, status: k.status, verdict: krVerdict(k.status), note: k.statusNote, by: k.statusBy && k.statusNote ? this.world.nameOf(k.statusBy) : null, evidence: k.evidence })),
      spentTokens: this.spent(g.id), grantTokens: g.grantTokens ?? 0,
      topUpTokens: g.topUpTokens, whatTopUpBuys: g.whatTopUpBuys,
      reportId: report ? report.id : null,
      shipped: report ? parseRollup(report.body).items.map((i) => i.title) : [],
      reports, filed: krs.some((k) => !!k.statusBy && !!this.world.agents.get(k.statusBy)),
    };
  }

  /**
   * Check the key-result evidence and top-up a report carries (grant C, kr_13txlz2pnc) before the report is filed: only a
   * session in the grant lane, for its own grant, and only that grant's open key results. Throws a refusal naming why;
   * returns the grant.
   */
  checkReportEvidence(lane: string | null | undefined, grantId: string | null | undefined, krs: ReportKrEvidence[]): Grant {
    const what = krs.length ? "keyResults" : "topUp";
    if (lane !== "grant" || !grantId) throw badRequest(`${what} is filed only from a grant-lane session, for its own grant: this session's lane is ${lane ?? "none"}. Leave ${what} out and say it in the report body.`);
    const g = this.world.grants.require(grantId, "grant");
    if (g.status !== "funded" && g.status !== "checkpoint") throw badRequest(`Grant ${g.id} is ${g.status}: ${what} is filed only on a funded or held grant.`);
    const seen = new Set<string>();
    for (const e of krs) {
      const k = this.world.keyResults.get(e.id);
      if (!k || k.grantId !== g.id) throw badRequest(`Key result ${e.id} is not a key result of your session's grant ${g.id}: file evidence only for its own (${this.keyResultsOf(g.id).map((x) => x.id).join(", ") || "none"}).`);
      if (!isOpenKr(k)) throw badRequest(`Key result ${e.id} is ${k.status}: a human decided it, so it takes no more evidence.`);
      if (seen.has(e.id)) throw badRequest(`Key result ${e.id} is named twice.`);
      seen.add(e.id);
    }
    return g;
  }

  /**
   * File a checked report's evidence (inside submit_report's transaction, after the report exists): each key result gets
   * the status, a note naming the report and statusBy = the fork; the top-up replaces the grant's (the latest wins).
   */
  fileReportEvidence(me: { id: string; name: string }, g: Grant, reportId: string, krs: ReportKrEvidence[], topUp: ReportTopUp | undefined): void {
    const now = nowIso();
    for (const e of krs) {
      const k = this.world.keyResults.require(e.id, "key result");
      // step 10: a report that claims the key result makes its evidence "claimed" (a verified one stays verified)
      const next = this.world.keyResults.upsert({ ...k, status: e.status, statusNote: `${e.evidence} (report ${reportId})`.slice(0, 2000), statusBy: me.id, evidence: evidenceAfter(k, e.status, false), updatedAt: now });
      this.world.events.append({
        type: "kr.updated", agentId: me.id, buildingId: k.buildingId, text: `Key result ${next.status}: ${next.text}`,
        payload: { grantId: g.id, keyResultId: k.id, status: next.status, from: k.status, by: me.id, byKind: "agent", edited: false, reportId },
      });
    }
    if (topUp) this.world.grants.upsert({ ...this.world.grants.require(g.id, "grant"), topUpTokens: topUp.tokens, whatTopUpBuys: topUp.buys, updatedAt: now });
  }

  /**
   * What a grant (or a plan not saved yet) is likely to cost, from the closed grants (grant-estimate.ts): advisory, read-only.
   * A grant's recorded estimate is its propose-time one; this computes a fresh one.
   */
  estimateFor(g: Grant | { buildingId: string; keyResults: number; askTokens: number }): GrantEstimate {
    if ("id" in g) return estimateGrant(this.world, { id: g.id, buildingId: g.buildingId, keyResults: this.keyResultsOf(g.id).length || g.testingPlan.length, askTokens: g.askTokens });
    return estimateGrant(this.world, g);
  }

  /** Record a fresh history estimate on a grant that has none (proposed before migration 083), without a history entry. */
  recordEstimate(id: string): void {
    const g = this.world.grants.require(id, "grant");
    if (!g.estimate) this.world.grants.upsert({ ...g, estimate: this.estimateFor(g) }); // advisory: updatedAt (the in-tray order) stays
  }

  /**
   * The cheap model's range (runtime estimate.ts), saved beside the propose-time estimate. Kept only while the grant still
   * carries the estimate the call was made for (`at`): a re-propose in between made a new one. No history entry, no event
   * the in-tray reacts to: advisory only. Returns whether it was saved.
   */
  recordModelEstimate(id: string, estimateAt: string, model: NonNullable<GrantEstimate["model"]>): boolean {
    const g = this.world.grants.get(id);
    if (!g?.estimate || g.estimate.at !== estimateAt) return false;
    this.world.grants.upsert({ ...g, estimate: { ...g.estimate, model } }); // advisory: updatedAt (the in-tray order) stays
    return true;
  }

  /** A closed grant's event payload part: its estimate against what it spent (empty when it had none). */
  private estimateVsActual(g: Grant): Partial<EstimateVsActual> {
    return estimateVsActual(g.estimate, this.spent(g.id)) ?? {};
  }

  /** A grant as GET /api/grants/:id and the Town Hall in-tray serve it: an open or live one carries `estimate` (recorded at propose, else fresh). */
  withEstimate(g: GrantView): GrantView {
    if (g.estimate || !["proposed", "countered", "funded", "checkpoint"].includes(g.status)) return g;
    return { ...g, estimate: this.estimateFor(g) };
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
      createdBy: o.createdBy, editedBy: null, sourceDocIds: o.sourceDocIds, exploreCapTokensPerDay: null, explore: null, exploreChunkTokens: null, desksTotal: null, createdAt: o.updatedAt, updatedAt: o.updatedAt,
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
    const steps = this.requireSteps(buildingId, inp.steps);
    const now = nowIso();
    const g = this.world.transaction(() => this.writeKeyResults(actor, this.world.grants.upsert({
      id: newId("gr"), buildingId, goalId, keyResultId: null, objective: inp.objective, approach: inp.approach, testingPlan: [], steps,
      stopCondition: inp.stopCondition, askTokens: this.askOf(steps), continues: this.requireContinues(buildingId, inp.continues),
      grantTokens: null, status: "draft", outcome: null, findingsDocIds: inp.findingsDocIds, picture: inp.picture ?? null, whatYoudSee: inp.whatYoudSee ?? "", checkpointsDone: [], checkpointDocId: null, topUpTokens: null, whatTopUpBuys: "",
      proposedBy: actor?.id ?? "system", fundedBy: null, fundedWith: null, fundedAt: null, closedAt: null, history: [], estimate: null, forecast: null, needsTopUp: false, createdAt: now, updatedAt: now,
    }), inp.keyResults));
    this.event("grant.created", g, actor, `Draft proposal: ${g.objective}`);
    return this.view(g);
  }

  /** PATCH /api/grants/:id while draft / countered (`building.manage`). `keyResults` replaces the grant's key results. */
  update(actor: Actor, id: string, input: UpdateGrantInput): GrantView {
    // askTokens is computed (the sum of the steps' sizes), never taken from the caller
    const { note, keyResults, goalId, askTokens: _ignored, ...fields } = UpdateGrantInput.parse(input);
    const g = this.world.grants.require(id, "grant");
    if (actor) this.world.permissions.require(actor, "building.manage", g.buildingId);
    this.requireStatus(g, ["draft", "countered"], "edited");
    const goal = goalId ? this.requireGoal(g.buildingId, goalId) : g.goalId;
    if (fields.continues !== undefined) fields.continues = this.requireContinues(g.buildingId, fields.continues, g.id) ?? undefined;
    const steps = fields.steps ? this.requireSteps(g.buildingId, fields.steps) : undefined;
    const askTokens = steps ? this.askOf(steps) : undefined;
    const next = this.world.transaction(() => {
      const history = g.status === "countered" ? [...g.history, this.entry(actor, "edit", askTokens ?? null, note ?? "")] : g.history;
      const saved = this.world.grants.upsert({ ...g, ...fields, ...(steps && { steps, askTokens }), goalId: goal, history, updatedAt: nowIso() });
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
      status: "not-started", statusNote: "", statusBy: null, evidence: "unknown", createdBy: by?.id ?? null, editedBy: null, sourceDocIds: [], objectiveId: null,
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

  /**
   * A proposal's steps (1-5): each sized S, M or L (no XL: a bigger step is split), its model one the building's forks run
   * on, its pages topic pages of the building.
   */
  private requireSteps(buildingId: string, steps: GrantStep[]): GrantStep[] {
    const b = this.world.buildings.require(buildingId, "building");
    if (steps.length < 1 || steps.length > 5) throw badRequest("A grant carries 1-5 steps.");
    return steps.map((s, i) => {
      if (!StepSize.safeParse(s.size).success) throw badRequest(`Step ${i + 1}: its size is ${JSON.stringify(s.size ?? null)}; a step's size is S, M or L. A step larger than L must be split into two steps.`);
      try {
        const model = checkForkModel(b, s.model);
        const pages = s.pages?.length ? attachablePages(this.world, buildingId, s.pages) : [];
        return { title: s.title, size: s.size, description: s.description, ...(model ? { model } : {}), ...(pages.length ? { pages } : {}) };
      } catch (e) {
        throw badRequest(`Step ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  /** A plan's ask: the sum of its steps' sizes from the collective's table (`Town.stepSizes`). */
  private askOf(steps: GrantStep[]): number {
    const table = grantPricingOf(this.world.town.get()).stepSizes;
    return steps.reduce((s, x) => s + table[x.size ?? "M"], 0);
  }

  /**
   * Queue step `k` (0-based) of a funded grant (grant B gr_b5fyqibfx2): funding queues step 1, a step's report the next
   * one (`queueNextStep`). It goes on the building queue (lane grant, charged to the grant; a fork of the manager runs
   * it on the step's model with its pages); a visitor manager is offered it. Null when the grant has no step `k`, is not
   * live, or the building has no manager agent (a human works its in-tray). No manager session in between.
   */
  queueStep(g: Grant, k: number, by: Actor, from?: { assignmentId: string; reportId: string }, note = ""): Assignment | null {
    const step = g.steps[k];
    if (!step || !LIVE.includes(g.status)) return null;
    const building = this.world.buildings.require(g.buildingId, "building");
    const manager = managerAgentOf(this.world, building);
    if (!manager) return null;
    const forkable = manager.kind === "resident";
    // re-checked at queue time: a model the building no longer allows falls back to its default, a page gone is dropped
    let model: string | null = null;
    try { model = forkable ? checkForkModel(building, step.model) : null; } catch { model = null; }
    const pages = (step.pages ?? []).filter((id) => { const d = this.world.docs.get(id); return d?.type === "wiki" && d.topicOf === g.buildingId; });
    const n = g.steps.length;
    const nextLine = g.steps[k + 1] ? `When you submit your report, step ${k + 2} ("${g.steps[k + 1]!.title}") is queued by itself unless your verdict is pivot (a pivot stops the chain for the manager's review).` : `This is the grant's last step: say in your report whether its key results can be claimed (the manager closes the grant with close_grant).`;
    const a = createAssignment(this.world, {
      agentId: manager.id, buildingId: g.buildingId, title: step.title.slice(0, 160),
      createdBy: by && by.kind === "human" ? holderOf(by) : { kind: "system", id: "system" },
      laneOverride: { lane: "grant", grantId: g.id, keyResultId: g.keyResultId, gap: null, sourceId: null },
      ...(forkable ? { model } : {}),
      ...(from ? { fromAssignmentId: from.assignmentId, fromReportId: from.reportId } : {}),
      description: `Grant ${g.id} "${g.objective}", step ${k + 1} of ${n}.${note.trim() ? `\n\nThe funder's note: ${note.trim()}` : ""}\n\n${step.description}\n\nThe plan's steps:\n${g.steps.map((s, i) => `${i + 1}. ${s.title}${i === k ? " (this one)" : i < k ? " (done)" : ""}`).join("\n")}\n\nKey results (the grant's own):\n${this.krLines(g)}\nStop condition: ${g.stopCondition}\n\n${nextLine}`,
    });
    return this.world.assignments.patch(a.id, { grantStep: k, ...(pages.length ? { pages } : {}) });
  }

  /**
   * A step's report was filed (submit_report, not parked): queue the grant's next step unless the verdict is pivot (the
   * manager's review decides then). The manager's review stop / redirect of that report cancels it while it waits.
   */
  queueNextStep(done: Assignment, reportId: string, verdict: string): Assignment | null {
    if (done.grantStep == null || !done.grantId || verdict === "pivot") return null;
    const g = this.world.grants.get(done.grantId);
    return g ? this.queueStep(g, done.grantStep + 1, null, { assignmentId: done.id, reportId }) : null;
  }

  /** draft / countered → proposed (`building.manage`). Several can be open per building, each decided on its own. Tells the humans who can fund. */
  propose(actor: Actor, id: string, note = ""): GrantView {
    const g = this.world.grants.require(id, "grant");
    if (actor) this.world.permissions.require(actor, "building.manage", g.buildingId);
    this.requireStatus(g, ["draft", "countered"], "proposed");
    if (!this.keyResultsOf(g.id).length) throw badRequest("A grant carries 1-5 key results: give keyResults (text, howToCheck, due) first.");
    if (!g.steps.length) throw badRequest("A grant carries 1-5 steps: give steps (title, description; one session each) first. Funding queues step 1.");
    // the estimate is recorded at (each) propose so the close can compare it with what the grant spent
    // the ask is the town's arithmetic: the sum of the steps' sizes from the table at propose time (docs/legible-delegation.md §7.3)
    const priced = { ...g, askTokens: this.askOf(g.steps) };
    const next = this.save(priced, actor, { status: "proposed", estimate: this.estimateFor(priced) }, "propose", priced.askTokens, note);
    this.event("grant.proposed", next, actor, `Proposal: ${next.objective} (${fmt(next.askTokens)} tokens)`);
    this.notifyFunders(next, actor, `${this.world.nameOf(next.proposedBy)} proposed "${next.objective}" for ${fmt(next.askTokens)} tokens. Fund, counter or reject it on the board.`);
    return this.view(next);
  }

  /**
   * POST /api/grants/:id/decide (`building.fund`). Proposed: fund (tokens default to the ask) / counter (edits + note,
   * back to the manager) / reject. Checkpoint: continue / adjust (tokens, stop condition) / cut.
   * Member funding: `fund` with `fundWith` (one of the funder's own Bank inputs) needs no `building.fund`, only a human
   * whose active input can still pay the grant's tokens; its sessions are then paid from that input first.
   * `via`: the human said it in a 1:1 and its agent did it for them (act_in_1on1); the history entry records both.
   */
  decide(actor: Actor, id: string, input: DecideGrantInput, via?: DecidedVia): GrantView {
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
        // no Bank gate (Mitchell, 1:1 mt_fgsticyyhr, 2026-11-02): a human may fund whatever they choose; what the usable
        // balance can't cover today is overdrawn and the grant's work waits its turn in the overdraft walk (free-tokens.ts)
        next = this.save(g, actor, { ...edits, status: "funded", grantTokens: tokens, checkpointsDone: passed(spent, tokens), fundedBy: actor ? holderOf(actor).id : "system", fundedWith, fundedAt: nowIso() }, "fund", tokens, inp.note, via);
        const from = fundedWith ? ` funded from ${this.world.bank.input(fundedWith)?.label ?? fundedWith}` : "";
        this.event("grant.funded", next, actor, `Funded: ${next.objective} (${fmt(tokens)} tokens${from})${this.overdraftNote(next)}`, deck);
        // grant B (gr_b5fyqibfx2): funding runs the plan, step 1 straight onto the building queue; no manager kickoff session
        this.queueStep(next, 0, actor, undefined, inp.note);
        break;
      }
      case "counter": {
        this.requireStatus(g, ["proposed"], "countered");
        if (!inp.note.trim()) throw badRequest("A counter needs a note saying what to change.");
        next = this.save(g, actor, { ...edits, status: "countered", ...(inp.tokens && { askTokens: inp.tokens }) }, "counter", inp.tokens ?? null, inp.note, via);
        const countered = this.event("grant.countered", next, actor, `Countered: ${next.objective}`, deck);
        this.notifyManager(next, actor, `A human countered your proposal "${next.objective}": ${inp.note}`);
        this.decisionAssignment(next, actor, "countered", inp.note, countered);
        break;
      }
      case "reject":
        this.requireStatus(g, ["proposed"], "rejected");
        next = this.save(g, actor, { status: "rejected", closedAt: nowIso() }, "reject", null, inp.note, via);
        // a rejected proposal's key results archive with it (goals keep no open ones)
        for (const k of this.keyResultsOf(g.id).filter(isOpenKr)) this.world.keyResults.upsert({ ...k, archivedAt: nowIso(), statusNote: `grant ${g.id} rejected`, updatedAt: nowIso() });
        const rejected = this.event("grant.rejected", next, actor, `Rejected: ${next.objective}`, deck);
        this.notifyManager(next, actor, `A human rejected your proposal "${next.objective}"${inp.note ? `: ${inp.note}` : "."}`);
        this.decisionAssignment(next, actor, "rejected", inp.note, rejected);
        break;
      case "continue":
        this.requireStatus(g, ["checkpoint"], "continued");
        if (spent >= (g.grantTokens ?? 0)) throw new AppError("conflict", "The grant is fully spent: top it up (adjust with more tokens) or cut it.");
        // the top-up line was about the tokens just granted: the next hold asks the forks for a new one
        next = this.save(g, actor, { status: "funded", topUpTokens: null, whatTopUpBuys: "" }, "continue", null, inp.note, via);
        this.event("grant.funded", next, actor, `Continued: ${next.objective}`, deck);
        break;
      case "adjust": {
        // a running grant is adjusted too: its forecast's money ask arrives before the hold (docs/legible-delegation.md §7.3 point 4)
        this.requireStatus(g, ["checkpoint", "funded"], "adjusted");
        const tokens = inp.tokens ?? g.grantTokens ?? 0;
        if (tokens <= spent) throw badRequest(`The grant has spent ${fmt(spent)} tokens: an adjusted grant must be more than that.`);
        const checkpointsDone = tokens === g.grantTokens ? g.checkpointsDone : passed(spent, tokens);
        // the forecast stays, measured against the new ceiling
        const forecast = g.forecast ? { ...g.forecast, ceiling: tokens, overCeiling: g.forecast.projected > tokens, shortfall: Math.max(0, g.forecast.projected - tokens) } : g.forecast;
        next = this.save(g, actor, { ...edits, status: "funded", grantTokens: tokens, checkpointsDone, topUpTokens: null, whatTopUpBuys: "", forecast, needsTopUp: !!forecast?.overCeiling }, "adjust", tokens, inp.note, via);
        this.event("grant.funded", next, actor, `Adjusted: ${next.objective} (${fmt(tokens)} tokens)${this.overdraftNote(next)}`, deck);
        break;
      }
      case "cut":
        // a running grant cut from its forecast's money ask stops: its forks wrap up, then it closes (`stop`)
        if (g.status === "funded") return this.stop(actor, g.id, { reason: inp.note.trim() || "Cut at its forecast: projected past its ceiling." });
        this.requireStatus(g, ["checkpoint"], "cut");
        next = this.save(g, actor, { status: "closed", outcome: "cut", closedAt: nowIso() }, "cut", null, inp.note, via);
        this.event("grant.closed", next, actor, `Cut: ${next.objective}`, { ...deck, ...this.estimateVsActual(next) });
        this.notifyManager(next, actor, `A human cut the grant "${next.objective}" at its checkpoint${inp.note ? `: ${inp.note}` : "."}`);
        break;
    }
    return this.view(next);
  }

  /**
   * What the overdraft walk says about a grant just funded or adjusted, for its event: "; N tokens overdrawn, its work
   * waits until the Bank can cover it" (or "partly covered, it runs"), or "" when the usable balance covers all of it.
   */
  private overdraftNote(g: Grant): string {
    const o = freeTokens(this.world, grantGoalOf(this.world, g)).overdrafted?.find((x) => x.id === g.id);
    if (!o) return "";
    return `; ${fmt(o.shortTokens)} tokens overdrawn, ${o.shortTokens >= o.tokens ? "its work waits" : "partly covered, it runs"} until the Bank can cover it`;
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

  /**
   * POST /api/grants/:id/close: the manager may withdraw a proposal (outcome `stopped`) or close a live grant as `done`
   * (closeDone); `building.fund` any outcome. Closing a live grant as `stopped` is a human's `stop` (the manager gets 403).
   */
  close(actor: Actor, id: string, input: CloseGrantInput): GrantView {
    const inp = CloseGrantInput.parse(input);
    if (inp.outcome === "done") return this.closeDone(actor, id, { note: inp.note });
    const g = this.world.grants.require(id, "grant");
    if (actor && !this.canFund(actor, g)) {
      if (inp.outcome !== "stopped") throw forbidden("building.fund", `Only a human who can fund this building can close a grant as "${inp.outcome}"; a manager can close it as "stopped".`);
      this.world.permissions.require(actor, "building.manage", g.buildingId);
    }
    if (TERMINAL.includes(g.status)) throw new AppError("conflict", `This grant is already ${g.status}.`);
    if (g.status === "stopping") throw new AppError("conflict", "This grant is already stopping: it closes as stopped once its forks have filed their reports.");
    if (!LIVE.includes(g.status) && inp.outcome !== "stopped") throw badRequest(`A ${g.status} proposal can only be withdrawn (outcome "stopped").`);
    if (!LIVE.includes(g.status)) return this.withdraw(actor, id, inp.note || "Withdrawn.");
    // stopping a funded grant is a human's (1:1 mt_a6wb51enia): the manager closes it as done, or asks a human to stop it
    if (inp.outcome === "stopped") {
      if (actor && actor.kind !== "human") throw forbidden("building.fund", `Only a human stops a ${g.status} grant: close it as done (close_grant) when its work is done, or ask a human to stop it.`);
      return this.stop(actor, id, { reason: inp.note.trim() || `Stopped by ${actor ? this.world.nameOf(actor.id) : "the town"}.` });
    }
    const next = this.save(g, actor, { status: "closed", outcome: inp.outcome, closedAt: nowIso() }, "close", null, inp.note);
    this.event("grant.closed", next, actor, `Closed (${inp.outcome}): ${next.objective}`, this.estimateVsActual(next));
    return this.view(next);
  }

  /**
   * The manager's `withdraw_grant` (1:1 mt_a6wb51enia): the manager takes back its own proposed or countered grant with a
   * note saying why. It closes as `stopped` (history action "withdraw", the note kept on it), leaves the Town Hall in-tray
   * and the review deck, and its open key results archive like a rejected proposal's. The humans who could fund it are
   * told why it vanished. A funded grant is refused: close_grant (done) or a human's cut.
   */
  withdraw(actor: Actor, id: string, note: string): GrantView {
    const g = this.world.grants.require(id, "grant");
    if (actor && !this.canFund(actor, g)) this.world.permissions.require(actor, "building.manage", g.buildingId);
    const why = (note ?? "").trim();
    if (!why) throw badRequest("Say why you withdraw it (note): it stays on the grant for the humans who saw the proposal.");
    if (TERMINAL.includes(g.status)) throw new AppError("conflict", `This grant is already ${g.status}.`);
    if (LIVE.includes(g.status)) throw new AppError("conflict", `${g.id} is ${g.status}: a funded grant is not withdrawn. Close it with close_grant when its work is done, or ask a human to cut it.`);
    this.requireStatus(g, ["draft", "proposed", "countered"], "withdrawn");
    return this.world.transaction(() => {
      const next = this.save(g, actor, { status: "closed", outcome: "stopped", closedAt: nowIso() }, "withdraw", null, why);
      for (const k of this.keyResultsOf(g.id).filter(isOpenKr)) this.world.keyResults.upsert({ ...k, archivedAt: nowIso(), statusNote: `grant ${g.id} withdrawn: ${why}`.slice(0, 2000), updatedAt: nowIso() });
      this.event("grant.closed", next, actor, `Withdrawn: ${next.objective}: ${why}`, { outcome: "stopped", withdrawn: true, note: why });
      if (g.status !== "draft") this.notifyFunders(next, actor, `${actor ? this.world.nameOf(actor.id) : "The manager"} withdrew the proposal "${next.objective}" (${next.id}, ${fmt(next.askTokens)} tokens asked): ${why}`);
      return this.view(next);
    });
  }

  /**
   * POST /api/grants/:id/stop (gr_8i952perny; 1:1 mt_a6wb51enia): a human who can fund the grant (`building.fund`, or the
   * captain of its goal) stops a funded or checkpoint grant mid-work. In one go: it goes to `stopping` (not live: nothing
   * new starts on it and it stops claiming free tokens), every fork running work on it is asked to wrap up (`interruptFork`,
   * the reason as the note; the 5-min hard stop applies), its queued grant work is cancelled ("Grant stopped: <reason>"),
   * its open key results archive as missed with the reason, and the manager is told. When no session runs on it any more
   * (at once when none did) `finishStopping` closes it as `stopped`, recording spent, granted and returned like closeDone.
   */
  stop(actor: Actor, id: string, input: StopGrantInput): GrantView {
    const { reason } = StopGrantInput.parse(input);
    const g = this.world.grants.require(id, "grant");
    if (actor && (actor.kind !== "human" || !this.canFund(actor, g))) throw forbidden("building.fund", "Only a human who can fund this building (or the captain of its goal) stops a grant.");
    if (g.status === "stopping") throw new AppError("conflict", "This grant is already stopping: it closes as stopped once its forks have filed their reports.");
    if (TERMINAL.includes(g.status)) throw new AppError("conflict", `This grant is already ${g.status}.`);
    this.requireStatus(g, LIVE, "stopped (withdraw or reject a proposal instead)");
    const who = actor ? this.world.nameOf(actor.id) : "The town";
    this.world.transaction(() => {
      const next = this.save(g, actor, { status: "stopping" }, "stop", null, reason);
      const now = nowIso();
      for (const k of this.keyResultsOf(g.id).filter(isOpenKr)) {
        // a human is acting, so missed is allowed; no postmortem: the stop note is the why
        const kr = this.world.keyResults.upsert({ ...k, status: "missed", statusNote: `Grant stopped: ${reason}`.slice(0, 2000), statusBy: actor ? holderOf(actor).id : "system", archivedAt: k.archivedAt ?? now, updatedAt: now });
        const missed = this.world.events.append({ type: "kr.updated", agentId: actor?.id ?? null, buildingId: k.buildingId, text: `Key result missed: ${kr.text}`, payload: { grantId: g.id, keyResultId: k.id, status: "missed", from: k.status, by: actor ? holderOf(actor).id : "system", byKind: actor ? holderOf(actor).kind : "system", edited: false, stopped: true } });
        retireAsks(this.world, "keyResult", k.id, missed.text);
      }
      const cancelled = this.cancelQueued(g.id, reason);
      const asker = actor ?? (managerAgentOf(this.world, this.world.buildings.require(g.buildingId, "building")) ?? null);
      const forks = asker ? this.runningSessions(g.id).flatMap((s) => {
        const fork = this.world.agents.get(s.agentId);
        return fork?.forkOf ? [interruptFork(this.world, asker, fork, s, `${who} stopped grant ${g.id}: ${reason}`).forkId] : [];
      }) : [];
      this.event("grant.updated", next, actor, `Stopping: ${next.objective}: ${reason}`, { stopping: true, reason, forks, cancelled });
      this.notifyManager(next, actor, `${who} stopped your grant ${g.id} "${next.objective}": ${reason}\n\n${forks.length ? `${forks.length} fork${forks.length === 1 ? " was" : "s were"} asked to wrap up and file their reports; it` : "It"} closes as stopped once no session runs on it. ${cancelled.length ? `Its ${cancelled.length} queued assignment${cancelled.length === 1 ? " was" : "s were"} cancelled. ` : ""}Its open key results are archived as missed. Don't assign more work on it.`);
    });
    this.finishStopping(g.id);
    return this.get(g.id);
  }

  /**
   * The runtime tick (and `stop` itself): every `stopping` grant (or just `grantId`) with no running session left closes as
   * `stopped`. Spend stays as booked; the unspent rest is returned: pool-funded, it is free tokens again (claims count only
   * live grants); member-funded, nothing moves and it stays on the member's input. Queued work that appeared meanwhile
   * (a fork's continuation) is cancelled too. `grant.closed` names the stopper (the history's "stop" entry) and the reason.
   */
  finishStopping(grantId?: string): Grant[] {
    const closed: Grant[] = [];
    const rows = grantId ? [this.world.grants.get(grantId)].filter((g): g is Grant => g?.status === "stopping") : this.world.grants.where("status = 'stopping'");
    for (const g of rows) {
      if (this.runningSessions(g.id).length) continue;
      const stopEntry = [...g.history].reverse().find((h) => h.action === "stop");
      const reason = stopEntry?.note ?? "";
      const by = stopEntry && stopEntry.byId !== "system" ? this.world.agents.first("kind = 'human' AND ownerUserId = ?", [stopEntry.byId]) ?? this.world.agents.get(stopEntry.byId) ?? null : null;
      const grantTokens = g.grantTokens ?? 0;
      const spentTokens = this.spent(g.id);
      const unspentTokens = Math.max(0, grantTokens - spentTokens);
      const input = g.fundedWith ? this.world.bank.input(g.fundedWith) : undefined;
      const returnedTo = g.fundedWith ? "input" : "pool";
      const returned = g.fundedWith ? `the unspent ${fmt(unspentTokens)} tokens stay on ${input?.label ?? g.fundedWith}` : `returned ${fmt(unspentTokens)} unspent tokens to the Bank as free tokens`;
      this.world.transaction(() => {
        this.cancelQueued(g.id, reason);
        const next = this.save(g, null, { status: "closed", outcome: "stopped", closedAt: nowIso() }, "close", unspentTokens, `Stopped: ${reason} (spent ${fmt(spentTokens)} of ${fmt(grantTokens)}; ${returned})`);
        this.event("grant.closed", next, by ?? null, `Stopped: ${next.objective}: ${reason}; ${returned}`, { outcome: "stopped", reason, spentTokens, grantTokens, unspentTokens, returnedTo, fundedWith: g.fundedWith, ...this.estimateVsActual(next) });
        closed.push(next);
      });
    }
    return closed;
  }

  /** Running sessions charged to a grant (its forks' and anyone's working on it). */
  private runningSessions(grantId: string): Session[] {
    return this.world.sessions.where("grantId = ? AND status = 'running'", [grantId]);
  }

  /** Cancel a stopped grant's queued work (pending, any lane naming it), the reason kept as the row's `heldReason`. Returns the ids. */
  private cancelQueued(grantId: string, reason: string): string[] {
    return this.world.assignments.where("grantId = ? AND status = 'pending'", [grantId])
      .map((a) => setAssignmentStatus(this.world, a.id, "cancelled", { heldReason: `Grant stopped: ${reason}`.slice(0, 500) }).id);
  }

  /**
   * The manager's `close_grant` (and POST /api/grants/:id/close with outcome "done"): the work is done before the grant is spent, so the manager
   * closes a funded (or checkpoint) grant as `closed`, outcome `done` (Mitchell, town hall mt_6830h8x5qk decision 3), and its open
   * key results go straight to `met` with the note as evidence, archived under their goal (town hall mt_v09cn7a8yr decision 2:
   * no human met/missed step; what shipped goes in the rollup). The unspent rest goes back to the Bank by construction:
   * reservations only count live grants. A human can still flip a key result to missed from the grant (PATCH /api/key-results/:id).
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
      for (const k of this.keyResultsOf(g.id).filter(isOpenKr)) this.updateKeyResult(actor, k.id, { status: "met", note }, { closing: true });
      this.event("grant.closed", next, actor, `Closed (done): ${next.objective}; ${returned}`, { outcome: "done", spentTokens, grantTokens, unspentTokens, ...this.estimateVsActual(next) });
      // the closed loop (docs/legible-delegation.md §8): funded on, for, closed at, what it bought (rewritten once the close report lands)
      closedLoopNotice(this.world, next, spentTokens);
      this.notifyFunders(next, actor, `${human ? this.world.nameOf(actor.id) : "The manager"} closed the grant "${next.objective}" as done: ${note} It spent ${fmt(spentTokens)} of ${fmt(grantTokens)} tokens and ${returned}. Its key results are marked met; flip one to missed from the grant if it did not ship.`);
      return this.view(next);
    });
  }

  /**
   * After a charge (`Budget.afterCharge`): every funded grant of the building whose derived spend reached its ceiling
   * (`holdAtTokens` = grantTokens; docs/legible-delegation.md §7.3) goes to `checkpoint`: new sessions on it are held
   * (running ones finish and book), `grant.checkpoint` is appended and the humans who can fund are told. No assignment is
   * created: the checkpoint card assembles itself from the grant's reports. The hold fires once per grantTokens value.
   * A grant already at checkpoint is untouched. Returns the grants it held.
   */
  checkpoints(buildingId: string): Grant[] {
    const held: Grant[] = [];
    for (const g of this.world.grants.where("buildingId = ? AND status = 'funded'", [buildingId])) {
      const tokens = g.grantTokens ?? 0;
      const spent = this.spent(g.id);
      const at = holdAtTokens(g);
      if (!tokens || at === null || spent < at) continue;
      const crossed = passed(spent, tokens).filter((f) => !g.checkpointsDone.includes(f));
      const pct = Math.round((spent / tokens) * 100);
      // the top-up line the forks filed since the last continue stays: it is what the card asks about (continue/adjust clear it)
      const next = this.save(g, null, { status: "checkpoint", checkpointsDone: [...g.checkpointsDone, ...crossed].sort() }, "checkpoint", spent,
        `Spend reached its ceiling: ${fmt(spent)} of ${fmt(tokens)} tokens (${pct}%). New sessions on it are held until a human decides.`);
      const hold = this.world.events.append({ type: "grant.checkpoint", buildingId, text: `Checkpoint at ${fmt(at)} tokens: ${g.objective} (${fmt(spent)} / ${fmt(tokens)} tokens)`, payload: { grantId: g.id, status: next.status, holdAtTokens: at, fraction: 1, spentTokens: spent, grantTokens: tokens } });
      askAtCheckpoint(this.world, next, spent, hold.text);
      this.notifyFunders(next, null, `"${g.objective}" reached its ceiling (${fmt(spent)} of ${fmt(tokens)} tokens spent): new sessions on it are held. Its checkpoint card shows its reports and key-result evidence; adjust or cut it in the Town Hall in-tray.`);
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
      if (!g.checkpointsDone.includes(0.5) || g.checkpointsDone.includes(HOLD_FULL) || g.checkpointsDone.includes(HOLD_RESERVE) || !tokens || this.spent(g.id) >= tokens) continue;
      const next = this.save(g, null, { status: "funded" }, "continue", null, "The 50% checkpoint was removed: a grant runs to its full number and is held only at 100%.");
      this.event("grant.funded", next, null, `Released from the 50% checkpoint: ${next.objective}`);
      released.push(next);
    }
    return released;
  }

  /**
   * A human's decision on a proposal reaches the manager as a pending row in its building's in-tray (work routing step 2,
   * 1:1 mt_lsyqj98z0w; continue / adjust / cut already are, `managerIntrayRow`): it is decided in the team-lead session,
   * never as a fork's job. Countered → how to answer (`propose_grant` with grantId); rejected → read the note. None when
   * the building has no manager agent: a human works its in-tray. Funding writes no row: it queues the plan's step 1
   * itself (`queueStep`, grant B gr_b5fyqibfx2).
   */
  private decisionAssignment(g: Grant, actor: Actor, decision: "countered" | "rejected", note: string, e: Event): void {
    const who = actor?.kind === "human" ? this.world.nameOf(actor.id) : "A human";
    const krs = this.krLines(g);
    const said = note.trim() ? `The note: ${note.trim()}` : "No note was given.";
    if (decision === "countered") {
      intrayRow(this.world, g.buildingId, e, {
        rule: "grant-countered", title: `Answer the counter on ${g.objective}`.slice(0, 160),
        what: `${who} countered proposal ${g.id}`,
        summary: `${who} countered your proposal ${g.id} "${g.objective}" (ask now ${fmt(g.askTokens)} tokens).\n\n${said}\n\nIt is your move: nothing on it runs until this is settled.\n\nKey results (the grant's own):\n${krs}`,
        footer: `To answer: read the note and the proposal (${g.id}: objective, key results, approach, stop condition, ask); revise what the note asks for and re-propose it with \`propose_grant\` and grantId ${g.id} (the revised plan, key results included, rewrites this proposal under the same id and sends it back to the Town Hall in-tray; your other open proposals are untouched); or, if the counter means the plan is wrong, \`withdraw_grant\` it and say what you'd propose instead. Then acknowledge this row with \`review\` approve.`,
      });
    } else {
      intrayRow(this.world, g.buildingId, e, {
        rule: "grant-rejected", title: `Grant ${g.id} rejected: read the note`.slice(0, 160),
        what: `${who} rejected proposal ${g.id}`,
        summary: `${who} rejected your proposal ${g.id} "${g.objective}" (${fmt(g.askTokens)} tokens asked).\n\n${said}\n\nIts key results (they close with it):\n${krs}`,
        footer: "Read the note and the proposal, then decide what follows: a different plan (`propose_grant` with its own key results), exploration first (`assign` lane exploration with a gap), or nothing until your next 1:1 or rollup. Acknowledge this row with `review` approve.",
      });
    }
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
   * `missed` (and undoing them) need `building.fund`, except `closing` (closeDone marks a closed-as-done grant's key results met). `text` / `howToCheck` / `sourceDocIds`: a human with
   * `building.manage`, or the building's own manager agent.
   */
  updateKeyResult(actor: Actor, id: string, input: UpdateKeyResultInput, opts: { closing?: boolean } = {}): KeyResult {
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
    if (actor && inp.status && !opts.closing) {
      const judged = inp.status === "met" || inp.status === "missed" || kr.status === "met" || kr.status === "missed";
      // a human who can fund the building, or the owner of the key result's goal (docs/goals.md "Captains on nodes")
      if (judged) {
        if (!this.world.permissions.can(actor, "building.fund", kr.buildingId) && !(kr.goalId && this.world.goalTree.owns(actor, kr.goalId))) throw forbidden("building.fund");
      } else if (!this.canManage(actor, kr.buildingId) && !this.managesGrantOf(actor, kr)) throw forbidden("building.manage");
      // a human marking it missed says why: the line is the postmortem's source (docs/goals.md "Postmortems on missed KRs")
      if (inp.status === "missed" && kr.status !== "missed" && actor.kind === "human" && !inp.note.trim()) throw badRequest("Say why it was missed (note): the line files the postmortem's source.");
    }
    const by = actor ? holderOf(actor) : null;
    const now = nowIso();
    // met or missed archives it under its goal (the goal stays); undoing that brings it back
    const archive = inp.status ? { archivedAt: inp.status === "met" || inp.status === "missed" ? kr.archivedAt ?? now : null } : {};
    const status = inp.status ? { status: inp.status, statusNote: inp.note, statusBy: by?.id ?? "system", ...archive } : {};
    const tree = moved ? { objectiveId: inp.objectiveId ?? null, goalId: inp.objectiveId ?? this.world.goalTree.attachmentOf(kr.buildingId) } : {};
    const evidence = inp.status ? { evidence: evidenceAfter(kr, inp.status, by?.kind === "user" && !opts.closing) } : {};
    const next = this.world.keyResults.upsert({ ...kr, ...words, ...(edited && { editedBy: by?.id ?? null }), ...tree, ...status, ...evidence, updatedAt: now });
    if (inp.status === "missed" && kr.status !== "missed") queuePostmortem(this.world, actor, next, inp.note);
    const patched = this.world.events.append({
      type: "kr.updated", agentId: actor?.id ?? null, buildingId: kr.buildingId, text: inp.status ? `Key result ${inp.status}: ${next.text}` : edited ? `Key result edited: ${next.text}` : `Key result moved: ${next.text}`,
      payload: {
        grantId: kr.grantId, keyResultId: kr.id, status: next.status, from: kr.status,
        by: by?.id ?? "system", byKind: by?.kind ?? "system", edited, ...(moved && { objectiveId: next.objectiveId, fromObjectiveId: kr.objectiveId }),
        ...(edited && { text: next.text, howToCheck: next.howToCheck, sourceDocIds: next.sourceDocIds, fromText: kr.text }),
      },
    });
    // asks on this key result retire when a human sets its status, or when it is met or missed by anyone (a close as done)
    if (inp.status && (by?.kind === "user" || next.status === "met" || next.status === "missed")) retireAsks(this.world, "keyResult", kr.id, patched.text);
    // a human verified it met (not the close as done, which marks every open one): a `verified` notice (§8)
    if (inp.status === "met" && kr.status !== "met" && by?.kind === "user" && !opts.closing) verifiedNotice(this.world, next, this.world.nameOf(by.id));
    return next;
  }

  // ---- helpers ----
  /**
   * The manager of the grant that carries a key result sets its status (up to `claimed`) even when the key result sits under another
   * building (a grant filed against a goal outside its building, or a goal key result folded into a grant: gr_mjr7nb438v, a Workshop
   * grant on Onboarding's kr_hee2pa2d5r, whose checkpoint was refused on 2026-10-31).
   */
  private managesGrantOf(actor: Actor, kr: KeyResult): boolean {
    const g = kr.grantId ? this.world.grants.get(kr.grantId) : undefined;
    return !!g && this.canManage(actor, g.buildingId);
  }

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

  private entry(actor: Actor, action: GrantHistoryEntry["action"], tokens: number | null, note: string, via?: DecidedVia): GrantHistoryEntry {
    const by = actor ? holderOf(actor) : { kind: "user" as const, id: "system" };
    return { at: nowIso(), byId: by.id, byKind: by.kind === "user" ? "user" : "agent", action, tokens, note, ...(via && { viaAgentId: via.agentId, viaMeetingId: via.meetingId }) };
  }

  private save(g: Grant, actor: Actor, patch: Partial<Grant>, action: GrantHistoryEntry["action"], tokens: number | null, note: string, via?: DecidedVia): Grant {
    return this.world.grants.upsert({ ...g, ...patch, history: [...g.history, this.entry(actor, action, tokens, note, via)], updatedAt: nowIso() });
  }

  private event(type: EventType, g: Grant, actor: Actor, text: string, extra: Record<string, unknown> = {}): Event {
    // action: the history entry that made it (fund, continue, adjust, cut, close…); the manager in-tray rule reads it (core/src/wakes.ts)
    const action = g.history.at(-1)?.action ?? null;
    const e = this.world.events.append({ type, agentId: actor?.id ?? null, buildingId: g.buildingId, text, payload: { grantId: g.id, status: g.status, action, ...extra } });
    // asks (docs/legible-delegation.md §4): a proposal files its money ask; a decision, close, withdraw or stop retires it
    onGrantEvent(this.world, g, e);
    return e;
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


/** Holds already behind a grant of `tokens` with `spent` so far (they won't fire again). */
function passed(spent: number, tokens: number): number[] {
  return spent >= tokens ? [HOLD_FULL] : [];
}

const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * A key result's evidence class after its status is set (docs/legible-delegation.md §5, build step 10): a human marking
 * it met verifies it; a claim makes unknown evidence claimed; a human taking back met drops it to what the new status
 * says (claimed, else unknown). Anything else keeps it. A passed `kr` claim check also verifies it (ask-checks.ts).
 */
function evidenceAfter(kr: KeyResult, status: KeyResult["status"], byHuman: boolean): NonNullable<KeyResult["evidence"]> {
  if (byHuman && status === "met") return "verified";
  if (byHuman && kr.status === "met" && status !== "met") return status === "claimed" ? "claimed" : "unknown";
  if (status === "claimed" && (kr.evidence ?? "unknown") === "unknown") return "claimed";
  return kr.evidence ?? "unknown";
}
