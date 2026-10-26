import {
  CloseGrantInput, CreateGrantInput, CreateKeyResultInput, DecideGrantInput, UpdateGrantInput, UpdateKeyResultInput,
  type Building, type Grant, type GrantHistoryEntry, type GrantStatus, type GrantView, type KeyResult, type Session, type Stoplight, type TokenCounts, ZERO_TOKENS, addTokens, stoplightOf,
} from "@muster-town/schema";
import { adjustedOfUsage } from "./bank.ts";
import { createAssignment, managerAgentOf, sendMessage } from "./domain.ts";
import type { EventType } from "./events.ts";
import { AppError, badRequest, forbidden } from "./errors.ts";
import type { Actor } from "./ops.ts";
import { DIRECTED } from "./lanes.ts";
import { holderOf } from "./permissions.ts";
import { BUDGET_POLICY } from "./policy.ts";
import { newId, nowIso } from "./util.ts";
import type { World } from "./world.ts";

/** Default exploration allowance: this share of the building's pool's daily inflow (BUDGET_POLICY, open question 1). */
export const EXPLORATION_SHARE = BUDGET_POLICY.explorationShare;
/** Spend fractions at which a funded grant pauses for a human checkpoint. */
export const CHECKPOINTS = [0.5, 1] as const;

const OPEN: GrantStatus[] = ["proposed", "countered"];
const LIVE: GrantStatus[] = ["funded", "checkpoint"];
const TERMINAL: GrantStatus[] = ["closed", "rejected"];

/** Why a goal-directed building is blocked (shown on GET /api/buildings/:id, the board and the Town Hall in-tray). */
export const BLOCKED_NO_KRS = "blocked: no key results to work toward";

export interface ExplorationBudget { allowanceTokens: number; spentTodayTokens: number }
/** A goal key result with the live (funded or checkpoint) grant working on it, if any. */
/** A goal key result as the API returns it: the live grant on it, and the names of who wrote / last edited it (null = unknown or never). */
export type GoalKeyResult = KeyResult & { grantId: string | null; createdByName: string | null; editedByName: string | null };
export interface GrantBoard { goal: string; keyResults: GoalKeyResult[]; blocked: string | null; stoplight: Stoplight | null; grants: GrantView[]; proposal: GrantView | null; exploration: ExplorationBudget }
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
    return { ...g, keyResult: (g.keyResultId && this.world.keyResults.get(g.keyResultId)) || null, spentTokens: this.adjustedSum(sessions), spentCounts };
  }

  /** The building goal's key results in order, each with the live grant working on it (null = open for exploration). */
  keyResults(buildingId: string): GoalKeyResult[] {
    const live = new Map(this.world.grants.where("buildingId = ? AND status IN ('funded', 'checkpoint') AND keyResultId IS NOT NULL", [buildingId], "ORDER BY fundedAt, rowid").map((g) => [g.keyResultId!, g.id]));
    return this.world.keyResults.where("buildingId = ?", [buildingId], "ORDER BY position, rowid").map((k) => ({
      ...k, grantId: live.get(k.id) ?? null,
      createdByName: k.createdBy ? this.world.nameOf(k.createdBy) : null, editedByName: k.editedBy ? this.world.nameOf(k.editedBy) : null,
    }));
  }

  /** The live (funded or checkpoint) grant working on a key result, if any. */
  liveGrantOf(keyResultId: string): Grant | undefined {
    return this.world.grants.first("keyResultId = ? AND status IN ('funded', 'checkpoint')", [keyResultId], "ORDER BY fundedAt, rowid");
  }

  /** A goal-directed building is blocked when its goal has no key results and it has no funded grant: nothing to explore against or implement. */
  blocked(b: Building | string): string | null {
    const building = typeof b === "string" ? this.world.buildings.get(b) : b;
    if (!building || building.kind === "town-hall" || building.budgetMode !== "goal-directed") return null;
    if (this.world.keyResults.count("buildingId = ?", [building.id])) return null;
    if (this.world.grants.count("buildingId = ? AND status IN ('funded', 'checkpoint')", [building.id])) return null;
    return BLOCKED_NO_KRS;
  }

  /**
   * The building's stoplight (town hall 2026-10-25; the map banner and the board): green = a funded grant runs on every
   * key result, yellow = a key result has no funded grant or a grant is held at its checkpoint, red = no key results or
   * no funded grant at all. Open buildings and the Town Hall: null.
   */
  stoplight(b: Building | string): Stoplight | null {
    const building = typeof b === "string" ? this.world.buildings.get(b) : b;
    if (!building || building.kind === "town-hall" || building.budgetMode !== "goal-directed") return null;
    return stoplightOf(this.keyResults(building.id), this.world.grants.where("buildingId = ? AND status IN ('funded', 'checkpoint')", [building.id], "ORDER BY fundedAt, rowid"));
  }

  /** Every blocked building (the Town Hall in-tray's summary). */
  blockedBuildings(): BlockedBuilding[] {
    return this.world.buildings.where("kind != 'town-hall' AND budgetMode = 'goal-directed'", [], "ORDER BY createdAt, rowid").flatMap((b) => {
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
      if (reason) this.blockedAssignment(b);
    });
  }

  /** The manager's wake when its building becomes blocked: settle goal key results with the humans (1:1, meeting or rollup) and write them. */
  private blockedAssignment(b: Building): void {
    const manager = managerAgentOf(this.world, b);
    if (!manager) return;
    const open = this.world.grants.first("buildingId = ? AND status IN ('proposed', 'countered')", [b.id]);
    createAssignment(this.world, {
      agentId: manager.id, buildingId: b.id, front: true, createdBy: { kind: "system", id: "system" }, laneOverride: DIRECTED,
      title: `Get human decisions: ${b.name} is ${BLOCKED_NO_KRS}`.slice(0, 160),
      description: `${b.name} is goal-directed, but its goal ("${b.goal || "(none set)"}") has no key results and it has no funded grant, so there is nothing to explore against or implement. A human writes the goal's key results (Building → Settings), and so do you for ${b.name}.

1. Draft 2-3 key results for the goal, each something a human can check in the live town, with a how-to-check line. Draw on the building's reports and exploration findings.
2. Settle them with Mitchell in your next 1:1 or a meeting, then write each with \`set_key_result\` (sourceDocIds: the meeting notes or report it comes from). Your next rollup lists them so Mitchell can keep or cut them. If you can't meet, put them in a rollup (\`submit_report\` with \`rollup: true\`; Needs from Mitchell: "Approve these key results for ${b.name}'s goal, or tell me what to change").
3. Once the goal has key results, propose a grant for one of them with \`propose_grant\` (keyResultId).${open ? `

The open proposal ${open.id} ("${open.objective}") names no goal key result yet; once there are key results, edit it to name one or withdraw it.` : ""}`,
    });
  }

  get(id: string): GrantView {
    return this.view(this.world.grants.require(id, "grant"));
  }

  /** Newest first. Drafts are left out unless `includeDrafts` (the building's managers). */
  list(buildingId: string, opts: { status?: GrantStatus; includeDrafts?: boolean } = {}): GrantView[] {
    this.world.buildings.require(buildingId, "building");
    const where = ["buildingId = ?"];
    const params: unknown[] = [buildingId];
    if (opts.status) { where.push("status = ?"); params.push(opts.status); }
    if (!opts.includeDrafts) where.push("status != 'draft'");
    return this.world.grants.where(where.join(" AND "), params, "ORDER BY createdAt DESC, rowid DESC").map((g) => this.view(g));
  }

  /** Can this actor see drafts (and edit) in the building? */
  canManage(actor: Actor, buildingId: string): boolean {
    return !actor || this.world.permissions.can(actor, "building.manage", buildingId) || this.world.permissions.can(actor, "building.fund", buildingId);
  }

  /** Today's (UTC) exploration spend of the building's residents against its allowance. */
  exploration(buildingId: string): ExplorationBudget {
    const b = this.world.buildings.require(buildingId, "building");
    const pool = this.world.bank.poolOf(b.id).id;
    const split = BUDGET_POLICY.explorationSplitAcrossPool ? Math.max(1, this.world.bank.buildingsIn(pool).filter((x) => x.kind !== "town-hall").length) : 1;
    const allowanceTokens = b.explorationTokensPerDay ?? (b.kind === "town-hall" ? 0
      : Math.floor(this.world.bank.poolDailyInflow(pool) * EXPLORATION_SHARE / split));
    const day = new Date(); day.setUTCHours(0, 0, 0, 0);
    const spentTodayTokens = this.adjustedSum(this.world.sessions.where(
      "lane = 'exploration' AND startedAt >= ? AND agentId IN (SELECT id FROM agents WHERE homeBuildingId = ?)", [day.toISOString(), buildingId]));
    return { allowanceTokens, spentTodayTokens };
  }

  /** GET /api/buildings/:id/board's budget part: live grants, the open proposal, exploration today. */
  board(buildingId: string): GrantBoard {
    const b = this.world.buildings.require(buildingId, "building");
    const live = this.world.grants.where(`buildingId = ? AND status IN ('funded', 'checkpoint')`, [buildingId], "ORDER BY fundedAt, rowid");
    const open = this.world.grants.first(`buildingId = ? AND status IN ('proposed', 'countered')`, [buildingId], "ORDER BY updatedAt DESC");
    return {
      goal: b.goal, keyResults: this.keyResults(buildingId), blocked: this.blocked(b), stoplight: this.stoplight(b),
      grants: live.map((g) => this.view(g)), proposal: open ? this.view(open) : null, exploration: this.exploration(buildingId),
    };
  }

  /** POST /api/buildings/:id/grants: a draft plan for one goal key result (`building.manage`). */
  create(actor: Actor, buildingId: string, input: CreateGrantInput): GrantView {
    const inp = CreateGrantInput.parse(input);
    this.world.buildings.require(buildingId, "building");
    if (actor) this.world.permissions.require(actor, "building.manage", buildingId);
    this.requireGoalKeyResult(buildingId, inp.keyResultId);
    const now = nowIso();
    const g = this.world.grants.upsert({
      id: newId("gr"), buildingId, keyResultId: inp.keyResultId, objective: inp.objective, approach: inp.approach, testingPlan: inp.testingPlan,
      stopCondition: inp.stopCondition, askTokens: inp.askTokens,
      grantTokens: null, status: "draft", outcome: null, findingsDocIds: inp.findingsDocIds, checkpointsDone: [], checkpointDocId: null,
      proposedBy: actor?.id ?? "system", fundedBy: null, fundedAt: null, closedAt: null, history: [], createdAt: now, updatedAt: now,
    });
    this.event("grant.created", g, actor, `Draft proposal: ${g.objective}`);
    return this.view(g);
  }

  /** PATCH /api/grants/:id while draft / countered (`building.manage`). `testingPlan` replaces the list. */
  update(actor: Actor, id: string, input: UpdateGrantInput): GrantView {
    const { note, ...fields } = UpdateGrantInput.parse(input);
    const g = this.world.grants.require(id, "grant");
    if (actor) this.world.permissions.require(actor, "building.manage", g.buildingId);
    this.requireStatus(g, ["draft", "countered"], "edited");
    if (fields.keyResultId) this.requireGoalKeyResult(g.buildingId, fields.keyResultId);
    const next = this.world.transaction(() => {
      const history = g.status === "countered" ? [...g.history, this.entry(actor, "edit", fields.askTokens ?? null, note ?? "")] : g.history;
      // work queued on it (never funded, so no checkpoint assignment among it) works toward the newly named key result
      if (fields.keyResultId && fields.keyResultId !== g.keyResultId) {
        for (const a of this.world.assignments.where("grantId = ? AND status IN ('pending', 'active')", [g.id])) this.world.assignments.upsert({ ...a, keyResultId: fields.keyResultId });
      }
      return this.world.grants.upsert({ ...g, ...fields, history, updatedAt: nowIso() });
    });
    this.event("grant.updated", next, actor, `Proposal edited: ${next.objective}`);
    return this.view(next);
  }

  /** draft / countered → proposed (`building.manage`). One open proposal per building. Tells the humans who can fund. */
  propose(actor: Actor, id: string, note = ""): GrantView {
    const g = this.world.grants.require(id, "grant");
    if (actor) this.world.permissions.require(actor, "building.manage", g.buildingId);
    this.requireStatus(g, ["draft", "countered"], "proposed");
    if (!g.keyResultId) throw badRequest("A grant names one of the building goal's key results: set keyResultId first (a human or the manager writes the goal's key results).");
    const other = this.world.grants.first(`buildingId = ? AND id != ? AND status IN ('proposed', 'countered')`, [g.buildingId, g.id]);
    if (other) throw new AppError("conflict", `This building already has an open proposal (${other.id}: ${other.objective}). Withdraw or finish it first.`);
    const next = this.save(g, actor, { status: "proposed" }, "propose", g.askTokens, note);
    this.event("grant.proposed", next, actor, `Proposal: ${next.objective} (${fmt(next.askTokens)} tokens)`);
    this.notifyFunders(next, actor, `${this.world.nameOf(next.proposedBy)} proposed "${next.objective}" for ${fmt(next.askTokens)} tokens. Fund, counter or reject it on the board.`);
    return this.view(next);
  }

  /**
   * POST /api/grants/:id/decide (`building.fund`). Proposed: fund (tokens default to the ask) / counter (edits + note,
   * back to the manager) / reject. Checkpoint: continue / adjust (tokens, KRs, stop condition) / cut.
   */
  decide(actor: Actor, id: string, input: DecideGrantInput): GrantView {
    const inp = DecideGrantInput.parse(input);
    const g = this.world.grants.require(id, "grant");
    if (actor) this.world.permissions.require(actor, "building.fund", g.buildingId);
    const spent = this.spent(g.id);
    const edits = { ...(inp.stopCondition && { stopCondition: inp.stopCondition }), ...(inp.testingPlan && { testingPlan: inp.testingPlan }) };
    let next: Grant;
    switch (inp.action) {
      case "fund": {
        this.requireStatus(g, ["proposed"], "funded");
        if (!g.keyResultId) throw badRequest("This grant names no goal key result: write the building's key results, then counter it so the manager names one.");
        const tokens = inp.tokens ?? g.askTokens;
        next = this.save(g, actor, { ...edits, status: "funded", grantTokens: tokens, checkpointsDone: passed(spent, tokens), fundedBy: actor ? holderOf(actor).id : "system", fundedAt: nowIso() }, "fund", tokens, inp.note);
        this.event("grant.funded", next, actor, `Funded: ${next.objective} (${fmt(tokens)} tokens)`);
        this.decisionAssignment(next, actor, "funded", inp.note);
        break;
      }
      case "counter": {
        this.requireStatus(g, ["proposed"], "countered");
        if (!inp.note.trim()) throw badRequest("A counter needs a note saying what to change.");
        next = this.save(g, actor, { ...edits, status: "countered", ...(inp.tokens && { askTokens: inp.tokens }) }, "counter", inp.tokens ?? null, inp.note);
        this.event("grant.countered", next, actor, `Countered: ${next.objective}`);
        this.notifyManager(next, actor, `A human countered your proposal "${next.objective}": ${inp.note}`);
        this.decisionAssignment(next, actor, "countered", inp.note);
        break;
      }
      case "reject":
        this.requireStatus(g, ["proposed"], "rejected");
        next = this.save(g, actor, { status: "rejected", closedAt: nowIso() }, "reject", null, inp.note);
        this.event("grant.rejected", next, actor, `Rejected: ${next.objective}`);
        this.notifyManager(next, actor, `A human rejected your proposal "${next.objective}"${inp.note ? `: ${inp.note}` : "."}`);
        this.decisionAssignment(next, actor, "rejected", inp.note);
        break;
      case "continue":
        this.requireStatus(g, ["checkpoint"], "continued");
        if (spent >= (g.grantTokens ?? 0)) throw new AppError("conflict", "The grant is fully spent: top it up (adjust with more tokens) or cut it.");
        next = this.save(g, actor, { status: "funded" }, "continue", null, inp.note);
        this.event("grant.funded", next, actor, `Continued: ${next.objective}`);
        break;
      case "adjust": {
        this.requireStatus(g, ["checkpoint"], "adjusted");
        const tokens = inp.tokens ?? g.grantTokens ?? 0;
        if (tokens <= spent) throw badRequest(`The grant has spent ${fmt(spent)} tokens: an adjusted grant must be more than that.`);
        const checkpointsDone = tokens === g.grantTokens ? g.checkpointsDone : passed(spent, tokens);
        next = this.save(g, actor, { ...edits, status: "funded", grantTokens: tokens, checkpointsDone }, "adjust", tokens, inp.note);
        this.event("grant.funded", next, actor, `Adjusted: ${next.objective} (${fmt(tokens)} tokens)`);
        break;
      }
      case "cut":
        this.requireStatus(g, ["checkpoint"], "cut");
        next = this.save(g, actor, { status: "closed", outcome: "cut", closedAt: nowIso() }, "cut", null, inp.note);
        this.event("grant.closed", next, actor, `Cut: ${next.objective}`);
        this.notifyManager(next, actor, `A human cut the grant "${next.objective}" at its checkpoint${inp.note ? `: ${inp.note}` : "."}`);
        break;
    }
    return this.view(next);
  }

  /** POST /api/grants/:id/close: the manager may close (or withdraw) as `stopped`; `building.fund` any outcome. */
  close(actor: Actor, id: string, input: CloseGrantInput): GrantView {
    const inp = CloseGrantInput.parse(input);
    const g = this.world.grants.require(id, "grant");
    if (actor && !this.world.permissions.can(actor, "building.fund", g.buildingId)) {
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
   * After a charge (`Budget.afterCharge`): every funded grant of the building whose derived spend crossed a checkpoint
   * fraction (50%, 100%) not yet done goes to `checkpoint`: new sessions on it are held, `grant.checkpoint` is appended,
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

  /** The manager's "Write the checkpoint for …" assignment (none when the building has no manager agent: humans decide from the in-tray). */
  private checkpointAssignment(g: Grant, spent: number, at: number): void {
    const building = this.world.buildings.require(g.buildingId, "building");
    const manager = managerAgentOf(this.world, building);
    if (!manager) return;
    const k = g.keyResultId ? this.world.keyResults.get(g.keyResultId) : undefined;
    const kr = k ? `${k.id} [${k.status}] ${k.text} (how to check: ${k.howToCheck})` : "(none named)";
    const plan = g.testingPlan.map((t) => `- ${t.text} (how to check: ${t.howToCheck})`).join("\n");
    const reports = this.world.assignments.where("grantId = ? AND reportId IS NOT NULL", [g.id], "ORDER BY updatedAt").map((a) => a.reportId!);
    createAssignment(this.world, {
      agentId: manager.id, buildingId: g.buildingId, front: true, createdBy: { kind: "system", id: "system" },
      laneOverride: { lane: "grant", grantId: g.id, keyResultId: null, gap: null },
      title: `Write the checkpoint for ${g.objective}`.slice(0, 160),
      description: `Grant ${g.id} "${g.objective}" crossed ${at * 100}% of its tokens: ${fmt(spent)} of ${fmt(g.grantTokens ?? 0)} spent. New sessions on it are held until a human continues, adjusts or cuts it in the Town Hall in-tray; this assignment runs anyway, charged to the grant.

Write the checkpoint for ${g.objective}: its key result's status with evidence a human can check in the live town (the testing plan says how), spend so far, and whether to continue.

Key result (on the building goal): ${kr}
${plan ? `Testing plan:\n${plan}\n` : ""}
Stop condition: ${g.stopCondition}

1. \`checkpoint_grant\` with grantId ${g.id}, the key result's status (not-started, on-track, at-risk or claimed; only a human marks met or missed) and a note with the evidence.
2. \`submit_report\` with \`rollup: true\` as your checkpoint report (it lands in the Town Hall in-tray and is linked to the grant). Sections: Shipped, Decided, Key results (the KR, its status, how to check it, what the testing plan showed, ${fmt(spent)} / ${fmt(g.grantTokens ?? 0)} tokens), Needs from Mitchell (continue, adjust or cut, and why). Put the reports the grant's work produced in provenance.sourceIds${reports.length ? `: ${reports.join(", ")}` : " (none yet; leave it empty)"}.`,
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
    const k = g.keyResultId ? this.world.keyResults.get(g.keyResultId) : undefined;
    const kr = k ? `${k.id} [${k.status}] ${k.text} (how to check: ${k.howToCheck})` : "(none named)";
    const said = note.trim() ? `\n\nThe note: ${note.trim()}` : "";
    const base = { agentId: manager.id, buildingId: g.buildingId, front: true, createdBy: { kind: "system" as const, id: "system" } };
    if (decision === "funded") {
      const plan = g.testingPlan.map((t) => `- ${t.text} (how to check: ${t.howToCheck})`).join("\n");
      createAssignment(this.world, {
        ...base, laneOverride: { lane: "grant", grantId: g.id, keyResultId: g.keyResultId, gap: null },
        title: `Grant ${g.id} funded: assign its first step or take it yourself`.slice(0, 160),
        description: `${who} funded grant ${g.id} "${g.objective}" with ${fmt(g.grantTokens ?? 0)} tokens.${said}

Nothing starts by itself: funding runs the plan only once its steps are assignments. This session is charged to the grant.

The plan (the grant page ${g.id} has the history):
Key result (on the building goal): ${kr}
Approach: ${g.approach || "(none written)"}
${plan ? `Testing plan:\n${plan}\n` : ""}Stop condition: ${g.stopCondition}${g.findingsDocIds.length ? `\nFindings it draws on: ${g.findingsDocIds.join(", ")}` : ""}

1. Cut the plan into steps, each one session's worth with a check a human can make in the live town.
2. \`assign\` the first step in lane grant with grantId ${g.id}: to the resident whose wiki covers it, or to yourself when it is yours (one owner per step). Sessions on it are charged to the grant and held at its 50% / 100% checkpoints.
3. Say in your report who got what and what the next step is.`,
      });
    } else if (decision === "countered") {
      createAssignment(this.world, {
        ...base, laneOverride: DIRECTED,
        title: `Answer the counter on ${g.objective}`.slice(0, 160),
        description: `${who} countered your proposal ${g.id} "${g.objective}" (ask now ${fmt(g.askTokens)} tokens).${said}

It is your move: nothing on the key result runs until this is settled.
Key result (on the building goal): ${kr}

1. Read the note and the proposal (${g.id}: objective, approach, testing plan, stop condition, ask).
2. Revise what the note asks for and re-propose it with \`propose_grant\` (the revised plan rewrites the proposal under the same id and sends it back to the Town Hall in-tray); or, if the counter means the plan is wrong, withdraw it and say what you'd propose instead.
3. Say in your report what changed and why.`,
      });
    } else {
      createAssignment(this.world, {
        ...base, laneOverride: DIRECTED,
        title: `Grant ${g.id} rejected: read the note`.slice(0, 160),
        description: `${who} rejected your proposal ${g.id} "${g.objective}" (${fmt(g.askTokens)} tokens asked).${said || "\n\nNo note was given."}

Key result (on the building goal): ${kr}${k ? "; it has no funded grant now, so it is open for exploration" : ""}.

1. Read the note and the proposal (${g.id}).
2. Decide what follows: a different plan for the key result (\`propose_grant\`), exploration against it first (\`assign\` lane exploration with keyResultId), or nothing until your next 1:1 or rollup.
3. Say in your report what you decided and why.`,
      });
    }
  }

  /**
   * \`checkpoint_grant\` (the manager, \`building.manage\`): set the status of the grant's key result (up to \`claimed\`) and
   * link the checkpoint report (\`reportId\`, else the rollup this session submits links itself). The grant stays at checkpoint.
   * A funded grant whose checkpoint already fired is accepted too: a human may continue or adjust it from the in-tray before
   * the manager's checkpoint session files (gr_iq5m7dug56, 2026-10-26: continued 4 min after the 50% hold).
   */
  fileCheckpoint(actor: Actor, grantId: string, input: { reportId?: string | null; status?: KeyResult["status"] | null; note?: string }): GrantView {
    const g = this.world.grants.require(grantId, "grant");
    if (actor && !this.world.permissions.can(actor, "building.manage", g.buildingId)) throw forbidden("building.manage");
    if (!(g.status === "funded" && g.checkpointsDone.length)) this.requireStatus(g, ["checkpoint"], "checkpointed");
    if (input.status === "met" || input.status === "missed") throw badRequest(`Only a human marks a key result ${input.status}; claim it instead.`);
    if (input.status && !g.keyResultId) throw badRequest("This grant names no goal key result, so there is no status to set.");
    if (input.reportId) {
      const d = this.world.docs.get(input.reportId);
      if (!d || d.type !== "report" || d.buildingId !== g.buildingId) throw badRequest(`${input.reportId} is not a report of this building.`);
    }
    return this.world.transaction(() => {
      if (input.status) this.updateKeyResult(actor, g.keyResultId!, { status: input.status, note: input.note ?? "" });
      if (input.reportId) this.world.grants.upsert({ ...this.world.grants.require(g.id), checkpointDocId: input.reportId, updatedAt: nowIso() });
      return this.get(g.id);
    });
  }

  /**
   * POST /api/buildings/:id/key-results (and the manager's `set_key_result`): a key result on the building goal. A human
   * with `building.manage` writes them, and so does the building's own manager agent (Mitchell, 1:1 mt_ayi4y9ybyj);
   * what a manager writes is listed in its next rollup (`writtenSince`) so a human can cut it.
   */
  createKeyResult(actor: Actor, buildingId: string, input: CreateKeyResultInput): KeyResult {
    const inp = CreateKeyResultInput.parse(input);
    const b = this.world.buildings.require(buildingId, "building");
    this.requireWriter(actor, b);
    this.requireSources(inp.sourceDocIds);
    const by = actor ? holderOf(actor) : null;
    const last = this.world.keyResults.first("buildingId = ?", [buildingId], "ORDER BY position DESC");
    const kr = this.world.keyResults.upsert({
      id: newId("kr"), buildingId, position: last ? last.position + 1 : 0, text: inp.text, howToCheck: inp.howToCheck,
      status: "not-started", statusNote: "", statusBy: null, createdBy: by?.id ?? null, editedBy: null, sourceDocIds: inp.sourceDocIds, updatedAt: nowIso(),
    });
    this.world.events.append({
      type: "kr.created", agentId: actor?.id ?? null, buildingId, text: `${b.name} key result: ${kr.text}`,
      payload: { keyResultId: kr.id, by: by?.id ?? "system", byKind: by?.kind ?? "system", text: kr.text, howToCheck: kr.howToCheck, sourceDocIds: kr.sourceDocIds },
    });
    return kr;
  }

  /** What the manager wrote since its last rollup (all of it before its first): `submit_report` appends it to the next rollup. */
  writtenSinceRollup(agentId: string, buildingId: string): ReturnType<Grants["writtenSince"]> {
    const last = this.world.docs.first("type = 'report' AND authorId = ? AND tags LIKE '%\"rollup\"%'", [agentId], "ORDER BY createdAt DESC, rowid DESC");
    return this.writtenSince(agentId, buildingId, last?.createdAt ?? "");
  }

  /** The key results `agentId` created or edited (the words) in `buildingId` after `since`, oldest first: a manager's rollup lists them. */
  writtenSince(agentId: string, buildingId: string, since: string): { keyResultId: string; action: "created" | "edited"; text: string; howToCheck: string; sourceDocIds: string[]; ts: string }[] {
    return this.world.events.list({ agentId, buildingId, types: ["kr.created", "kr.updated"], limit: 1000 })
      .filter((e) => e.ts > since && (e.type === "kr.created" || e.payload.edited === true))
      .map((e) => ({
        keyResultId: String(e.payload.keyResultId), action: e.type === "kr.created" ? "created" as const : "edited" as const,
        text: String(e.payload.text ?? e.text), howToCheck: String(e.payload.howToCheck ?? ""),
        sourceDocIds: Array.isArray(e.payload.sourceDocIds) ? e.payload.sourceDocIds.map(String) : [], ts: e.ts,
      }));
  }

  /** DELETE /api/key-results/:id (a human with `building.manage`). Refused while an open or live grant names it. */
  deleteKeyResult(actor: Actor, id: string): void {
    const kr = this.world.keyResults.require(id, "key result");
    this.requireHuman(actor, kr.buildingId, "deletes");
    const g = this.world.grants.first("keyResultId = ? AND status IN ('draft', 'proposed', 'countered', 'funded', 'checkpoint')", [id]);
    if (g) throw new AppError("conflict", `Grant ${g.id} ("${g.objective}", ${g.status}) names this key result: close or re-point it first.`);
    this.world.keyResults.delete(id);
    this.world.events.append({ type: "kr.deleted", agentId: actor?.id ?? null, buildingId: kr.buildingId, text: `Key result removed: ${kr.text}`, payload: { keyResultId: id } });
  }

  /**
   * PATCH /api/key-results/:id (and `set_key_result` with an id). `status`: the manager up to `claimed`; `met` /
   * `missed` (and undoing them) need `building.fund`. `text` / `howToCheck` / `sourceDocIds`: a human with
   * `building.manage`, or the building's own manager agent.
   */
  updateKeyResult(actor: Actor, id: string, input: UpdateKeyResultInput): KeyResult {
    const inp = UpdateKeyResultInput.parse(input);
    const kr = this.world.keyResults.require(id, "key result");
    const words = {
      ...(inp.text !== undefined && { text: inp.text }), ...(inp.howToCheck !== undefined && { howToCheck: inp.howToCheck }),
      ...(inp.sourceDocIds !== undefined && { sourceDocIds: inp.sourceDocIds }),
    };
    const edited = Object.keys(words).length > 0;
    if (!inp.status && !edited) throw badRequest("Nothing to change: give status, text, howToCheck or sourceDocIds.");
    if (edited) {
      this.requireWriter(actor, this.world.buildings.require(kr.buildingId, "building"));
      if (inp.sourceDocIds) this.requireSources(inp.sourceDocIds);
    }
    if (actor && inp.status) {
      const judged = inp.status === "met" || inp.status === "missed" || kr.status === "met" || kr.status === "missed";
      if (judged) this.world.permissions.require(actor, "building.fund", kr.buildingId);
      else if (!this.canManage(actor, kr.buildingId)) throw forbidden("building.manage");
    }
    const by = actor ? holderOf(actor) : null;
    const status = inp.status ? { status: inp.status, statusNote: inp.note, statusBy: by?.id ?? "system" } : {};
    const next = this.world.keyResults.upsert({ ...kr, ...words, ...(edited && { editedBy: by?.id ?? null }), ...status, updatedAt: nowIso() });
    this.world.events.append({
      type: "kr.updated", agentId: actor?.id ?? null, buildingId: kr.buildingId, text: inp.status ? `Key result ${inp.status}: ${next.text}` : `Key result edited: ${next.text}`,
      payload: {
        grantId: this.liveGrantOf(kr.id)?.id ?? null, keyResultId: kr.id, status: next.status, from: kr.status,
        by: by?.id ?? "system", byKind: by?.kind ?? "system", edited,
        ...(edited && { text: next.text, howToCheck: next.howToCheck, sourceDocIds: next.sourceDocIds, fromText: kr.text }),
      },
    });
    return next;
  }

  // ---- helpers ----
  /** A human with `building.manage`, or the building's own manager agent, writes the goal's key results. */
  private requireWriter(actor: Actor, b: Building): void {
    if (!actor) return;
    if (actor.kind !== "human") {
      if (b.managerAgentId === actor.id) return;
      throw forbidden("building.manage", `Only a human or ${b.name}'s manager writes its goal's key results.`);
    }
    this.world.permissions.require(actor, "building.manage", b.id);
  }

  /** Only a human (`building.manage`) deletes a key result. */
  private requireHuman(actor: Actor, buildingId: string, verb: string): void {
    if (!actor) return;
    if (actor.kind !== "human") throw forbidden("building.manage", `Only a human ${verb} a key result of the goal.`);
    this.world.permissions.require(actor, "building.manage", buildingId);
  }

  /** A key result's sources are published docs (meeting notes, reports), not drafts. */
  private requireSources(ids: string[]): void {
    for (const id of ids) {
      const d = this.world.docs.get(id);
      if (!d || d.state === "draft") throw badRequest(`Source ${id} is not a published document (meeting notes or a report).`);
    }
  }

  private requireGoalKeyResult(buildingId: string, keyResultId: string): void {
    const kr = this.world.keyResults.get(keyResultId);
    if (!kr || kr.buildingId !== buildingId) throw badRequest(`${keyResultId} is not a key result of this building's goal.`);
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

  private event(type: EventType, g: Grant, actor: Actor, text: string): void {
    // action: the history entry that made it (fund, continue, adjust, cut, close…); the manager in-tray rule reads it (core/src/wakes.ts)
    const action = g.history.at(-1)?.action ?? null;
    this.world.events.append({ type, agentId: actor?.id ?? null, buildingId: g.buildingId, text, payload: { grantId: g.id, status: g.status, action } });
  }

  /** Inbox note to every human (avatar) who can fund the building. */
  private notifyFunders(g: Grant, actor: Actor, body: string): void {
    const from = actor ? holderOf(actor) : { kind: "system" as const, id: "system" };
    for (const h of this.world.agents.where("kind = 'human' AND status != 'retired'")) {
      if (h.id === actor?.id || !this.world.permissions.can(h, "building.fund", g.buildingId)) continue;
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
