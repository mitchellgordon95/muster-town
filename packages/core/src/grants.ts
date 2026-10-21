import {
  CloseGrantInput, CreateGrantInput, DecideGrantInput, UpdateGrantInput, UpdateKeyResultInput,
  type Grant, type GrantHistoryEntry, type GrantStatus, type GrantView, type KeyResult,
} from "@muster-town/schema";
import { sendMessage } from "./domain.ts";
import type { EventType } from "./events.ts";
import { AppError, badRequest, forbidden } from "./errors.ts";
import type { Actor } from "./ops.ts";
import { holderOf } from "./permissions.ts";
import { newId, nowIso } from "./util.ts";
import type { World } from "./world.ts";

/** Default exploration allowance: this share of the building's pool's daily inflow (Mitchell, 2026-10-21). */
export const EXPLORATION_SHARE = 0.1;
/** Spend fractions at which a funded grant pauses for a human checkpoint. */
export const CHECKPOINTS = [0.5, 1] as const;

const OPEN: GrantStatus[] = ["proposed", "countered"];
const LIVE: GrantStatus[] = ["funded", "checkpoint"];
const TERMINAL: GrantStatus[] = ["closed", "rejected"];

export interface ExplorationBudget { allowanceTokens: number; spentTodayTokens: number }
export interface GrantBoard { goal: string; grants: GrantView[]; proposal: GrantView | null; exploration: ExplorationBudget }

type KeyResultInput = { text: string; howToCheck: string };

/**
 * Goal-directed budgets: a building's proposals and grants (design dc_k955hun6c4). The manager drafts and proposes
 * (`building.manage`); a human with `building.fund` funds, counters, rejects and decides checkpoints. Spend is derived
 * from sessions (SUM of tokens by grantId), never stored. `null` actor = system: no permission checks.
 */
export class Grants {
  constructor(private world: World) {}

  spent(grantId: string): number {
    return this.world.sessions.sum("tokens", "grantId = ?", [grantId]);
  }

  view(g: Grant): GrantView {
    return { ...g, keyResults: this.world.keyResults.where("grantId = ?", [g.id], "ORDER BY position"), spentTokens: this.spent(g.id) };
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
    const allowanceTokens = b.explorationTokensPerDay ?? (b.kind === "town-hall" ? 0
      : Math.floor(this.world.bank.poolDailyInflow(this.world.bank.poolOf(b.id).id) * EXPLORATION_SHARE));
    const day = new Date(); day.setUTCHours(0, 0, 0, 0);
    const spentTodayTokens = this.world.sessions.sum("tokens",
      "lane = 'exploration' AND startedAt >= ? AND agentId IN (SELECT id FROM agents WHERE homeBuildingId = ?)", [day.toISOString(), buildingId]);
    return { allowanceTokens, spentTodayTokens };
  }

  /** GET /api/buildings/:id/board's budget part: live grants, the open proposal, exploration today. */
  board(buildingId: string): GrantBoard {
    const b = this.world.buildings.require(buildingId, "building");
    const live = this.world.grants.where(`buildingId = ? AND status IN ('funded', 'checkpoint')`, [buildingId], "ORDER BY fundedAt, rowid");
    const open = this.world.grants.first(`buildingId = ? AND status IN ('proposed', 'countered')`, [buildingId], "ORDER BY updatedAt DESC");
    return { goal: b.goal, grants: live.map((g) => this.view(g)), proposal: open ? this.view(open) : null, exploration: this.exploration(buildingId) };
  }

  /** POST /api/buildings/:id/grants: a draft with 2-3 key results (`building.manage`). */
  create(actor: Actor, buildingId: string, input: CreateGrantInput): GrantView {
    const inp = CreateGrantInput.parse(input);
    this.world.buildings.require(buildingId, "building");
    if (actor) this.world.permissions.require(actor, "building.manage", buildingId);
    const now = nowIso();
    const g = this.world.transaction(() => {
      const g = this.world.grants.upsert({
        id: newId("gr"), buildingId, objective: inp.objective, stopCondition: inp.stopCondition, askTokens: inp.askTokens,
        grantTokens: null, status: "draft", outcome: null, findingsDocIds: inp.findingsDocIds, checkpointsDone: [], checkpointDocId: null,
        proposedBy: actor?.id ?? "system", fundedBy: null, fundedAt: null, closedAt: null, history: [], createdAt: now, updatedAt: now,
      });
      this.setKeyResults(g.id, inp.keyResults);
      return g;
    });
    this.event("grant.created", g, actor, `Draft proposal: ${g.objective}`);
    return this.view(g);
  }

  /** PATCH /api/grants/:id while draft / countered (`building.manage`). `keyResults` replaces the list. */
  update(actor: Actor, id: string, input: UpdateGrantInput): GrantView {
    const { note, keyResults, ...fields } = UpdateGrantInput.parse(input);
    const g = this.world.grants.require(id, "grant");
    if (actor) this.world.permissions.require(actor, "building.manage", g.buildingId);
    this.requireStatus(g, ["draft", "countered"], "edited");
    const next = this.world.transaction(() => {
      if (keyResults) this.setKeyResults(g.id, keyResults);
      const history = g.status === "countered" ? [...g.history, this.entry(actor, "edit", fields.askTokens ?? null, note ?? "")] : g.history;
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
    const edits = { ...(inp.stopCondition && { stopCondition: inp.stopCondition }) };
    const kr = () => { if (inp.keyResults) this.setKeyResults(g.id, inp.keyResults); };
    let next: Grant;
    switch (inp.action) {
      case "fund": {
        this.requireStatus(g, ["proposed"], "funded");
        const tokens = inp.tokens ?? g.askTokens;
        next = this.world.transaction(() => {
          kr();
          return this.save(g, actor, { ...edits, status: "funded", grantTokens: tokens, checkpointsDone: passed(spent, tokens), fundedBy: actor ? holderOf(actor).id : "system", fundedAt: nowIso() }, "fund", tokens, inp.note);
        });
        this.event("grant.funded", next, actor, `Funded: ${next.objective} (${fmt(tokens)} tokens)`);
        break;
      }
      case "counter": {
        this.requireStatus(g, ["proposed"], "countered");
        if (!inp.note.trim()) throw badRequest("A counter needs a note saying what to change.");
        next = this.world.transaction(() => {
          kr();
          return this.save(g, actor, { ...edits, status: "countered", ...(inp.tokens && { askTokens: inp.tokens }) }, "counter", inp.tokens ?? null, inp.note);
        });
        this.event("grant.countered", next, actor, `Countered: ${next.objective}`);
        this.notifyManager(next, actor, `A human countered your proposal "${next.objective}": ${inp.note}`);
        break;
      }
      case "reject":
        this.requireStatus(g, ["proposed"], "rejected");
        next = this.save(g, actor, { status: "rejected", closedAt: nowIso() }, "reject", null, inp.note);
        this.event("grant.rejected", next, actor, `Rejected: ${next.objective}`);
        this.notifyManager(next, actor, `A human rejected your proposal "${next.objective}"${inp.note ? `: ${inp.note}` : "."}`);
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
        next = this.world.transaction(() => {
          kr();
          const checkpointsDone = tokens === g.grantTokens ? g.checkpointsDone : passed(spent, tokens);
          return this.save(g, actor, { ...edits, status: "funded", grantTokens: tokens, checkpointsDone }, "adjust", tokens, inp.note);
        });
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

  /** PATCH /api/key-results/:id: the manager up to `claimed`; `met` / `missed` (and undoing them) need `building.fund`. */
  updateKeyResult(actor: Actor, id: string, input: UpdateKeyResultInput): KeyResult {
    const inp = UpdateKeyResultInput.parse(input);
    const kr = this.world.keyResults.require(id, "key result");
    const g = this.world.grants.require(kr.grantId, "grant");
    if (actor) {
      const judged = inp.status === "met" || inp.status === "missed" || kr.status === "met" || kr.status === "missed";
      if (judged) this.world.permissions.require(actor, "building.fund", g.buildingId);
      else if (!this.canManage(actor, g.buildingId)) throw forbidden("building.manage");
    }
    if (!LIVE.includes(g.status)) throw new AppError("conflict", `Key results can only change on a funded grant (this one is ${g.status}).`);
    const next = this.world.keyResults.upsert({ ...kr, status: inp.status, statusNote: inp.note, statusBy: actor ? holderOf(actor).id : "system", updatedAt: nowIso() });
    this.world.events.append({
      type: "kr.updated", agentId: actor?.id ?? null, buildingId: g.buildingId, text: `Key result ${inp.status}: ${kr.text}`,
      payload: { grantId: g.id, keyResultId: kr.id, status: inp.status, from: kr.status },
    });
    return next;
  }

  // ---- helpers ----
  private setKeyResults(grantId: string, krs: KeyResultInput[]): void {
    for (const old of this.world.keyResults.where("grantId = ?", [grantId])) this.world.keyResults.delete(old.id);
    const now = nowIso();
    krs.forEach((k, position) => this.world.keyResults.upsert({
      id: newId("kr"), grantId, position, text: k.text, howToCheck: k.howToCheck, status: "not-started", statusNote: "", statusBy: null, updatedAt: now,
    }));
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
    this.world.events.append({ type, agentId: actor?.id ?? null, buildingId: g.buildingId, text, payload: { grantId: g.id, status: g.status } });
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
