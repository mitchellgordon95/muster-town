import {
  CreateGoalInput, CreateTreeKeyResultInput, DecideGoalProposalInput, ProposeGoalInput, ROOT_GOAL_ID, RetireGoalInput, UpdateGoalInput,
  Event, type Building, type Goal, type GoalProposal, type KeyResult,
} from "@muster-town/schema";
import { sendMessage } from "./domain.ts";
import { AppError, badRequest, forbidden } from "./errors.ts";
import type { Actor } from "./ops.ts";
import { holderOf, type Holder } from "./permissions.ts";
import { newId, nowIso } from "./util.ts";
import type { World } from "./world.ts";

/** A goal as GET /api/goals returns it: its path from the root, its effective owner, its children, key results and attached buildings. */
export interface GoalNode extends Goal {
  /** the effective owner: this goal's, else the nearest owned ancestor's (null = the town admins, the root's owners) */
  owner: { goalId: string; userId: string | null; name: string };
  buildings: { id: string; name: string }[];
  keyResults: (KeyResult & { grantId: string | null })[];
  children: GoalNode[];
}
/** A proposal as the API returns it: flagged when it reaches outside the proposing building's subtree. */
export type GoalProposalView = GoalProposal & { proposedByName: string; outsideScope: boolean };

const isOpenKr = (k: KeyResult) => !k.archivedAt && k.status !== "met" && k.status !== "missed";

/**
 * The town goal tree (docs/goals.md, build step 1): one root (the town goal), any goal may have child goals, key results
 * are dated leaves under a goal, and every building is attached to exactly one goal. Admins (`goals.edit`) edit it
 * anywhere; a goal's owner (a human) edits, and decides and funds grants, within its subtree; managers and their forks
 * propose. History is the event log. `null` actor = system: no permission checks.
 */
export class Goals {
  constructor(private world: World) {}

  // ---- reading ----
  get(id: string): Goal | undefined { return this.world.goals.get(id); }
  require(id: string): Goal { return this.world.goals.require(id, "goal"); }
  root(): Goal { return this.require(ROOT_GOAL_ID); }

  children(id: string, opts: { retired?: boolean } = {}): Goal[] {
    return this.world.goals.where(opts.retired ? "parentId = ?" : "parentId = ? AND status = 'active'", [id], "ORDER BY position, createdAt, rowid");
  }

  /** The goal and its ancestors, the goal first, the root last. */
  ancestors(id: string): Goal[] {
    const out: Goal[] = [];
    const seen = new Set<string>();
    for (let g = this.get(id); g && !seen.has(g.id); g = g.parentId ? this.get(g.parentId) : undefined) { out.push(g); seen.add(g.id); }
    return out;
  }

  /** "Root › … › goal" texts, for briefs and errors. */
  pathText(id: string, max = 60): string {
    return this.ancestors(id).reverse().map((g) => clip(g.text, max)).join(" › ");
  }

  /** The goal and every goal under it (retired ones included: their archived key results stay theirs). */
  subtreeIds(id: string): Set<string> {
    const ids = new Set<string>([id]);
    const all = this.world.goals.all();
    for (let grew = true; grew;) {
      grew = false;
      for (const g of all) if (g.parentId && ids.has(g.parentId) && !ids.has(g.id)) { ids.add(g.id); grew = true; }
    }
    return ids;
  }

  /** The goal the building is attached to (the root when not repaired yet). */
  attachmentOf(b: Building | string): string {
    const building = typeof b === "string" ? this.world.buildings.get(b) : b;
    return (building?.goalId && this.get(building.goalId) ? building.goalId : ROOT_GOAL_ID);
  }

  /** The building's subtree: its attachment and everything under it. */
  scopeOf(buildingId: string): Set<string> {
    return this.subtreeIds(this.attachmentOf(buildingId));
  }

  /** Every key result under the building's subtree, in tree order (open and archived). */
  keyResultsInScope(buildingId: string): KeyResult[] {
    const scope = this.scopeOf(buildingId);
    return this.world.keyResults.where("goalId IS NOT NULL", [], "ORDER BY position, rowid").filter((k) => scope.has(k.goalId!));
  }

  /** The one scope check for grants and lanes: the key result is open (not met, missed or archived) and in the building's subtree. */
  inScope(buildingId: string, krId: string): boolean {
    const kr = this.world.keyResults.get(krId);
    return !!kr && isOpenKr(kr) && !!kr.goalId && this.scopeOf(buildingId).has(kr.goalId);
  }

  /** `inScope` that explains a refusal; returns the key result. */
  requireInScope(buildingId: string, krId: string): KeyResult {
    const kr = this.world.keyResults.get(krId);
    if (!kr) throw badRequest(`${krId} is not a key result of the town goal tree.`);
    if (!isOpenKr(kr)) throw badRequest(`Key result ${krId} is ${kr.status === "met" || kr.status === "missed" ? kr.status : "archived"}: work names an open key result.`);
    if (!kr.goalId || !this.scopeOf(buildingId).has(kr.goalId)) {
      const b = this.world.buildings.get(buildingId);
      throw badRequest(`Key result ${krId} is not in ${b?.name ?? buildingId}'s subtree (attached to "${clip(this.get(this.attachmentOf(buildingId))?.text ?? "", 80)}"): it sits under "${clip(kr.goalId ? this.get(kr.goalId)?.text ?? kr.goalId : "no goal", 80)}".`);
    }
    return kr;
  }

  /** Does the building's subtree hold an open key result? (A goal-directed building without one, and without a funded grant, is blocked.) */
  hasOpenKr(buildingId: string): boolean {
    const scope = this.scopeOf(buildingId);
    return this.world.keyResults.where("goalId IS NOT NULL AND archivedAt IS NULL AND status NOT IN ('met', 'missed')").some((k) => scope.has(k.goalId!));
  }

  // ---- owners ----
  /** The effective owner of a goal: its own, else the nearest owned ancestor's; `userId` null = the town admins (the root). */
  ownerOf(goalId: string): { goalId: string; userId: string | null } {
    for (const g of this.ancestors(goalId)) if (g.ownerId) return { goalId: g.id, userId: g.ownerId };
    return { goalId: ROOT_GOAL_ID, userId: null };
  }

  /** Does the actor (a human, as its user) own the goal or one of its ancestors? Owners are humans only for now. */
  owns(actor: Actor, goalId: string): boolean {
    if (!actor) return true;
    const h = holderOf(actor);
    if (h.kind !== "user") return false;
    return this.ancestors(goalId).some((g) => g.ownerId === h.id);
  }

  /** `goals.edit` at the goal: town-wide (admins), or as an owner of it or an ancestor. */
  canEdit(actor: Actor, goalId: string): boolean {
    if (!actor) return true;
    if (this.world.permissions.can(actor, "goals.edit")) return true;
    return this.owns(actor, goalId);
  }

  requireEdit(actor: Actor, goalId: string): void {
    if (!this.canEdit(actor, goalId)) throw forbidden("goals.edit", `Only an admin or the owner of "${clip(this.get(goalId)?.text ?? goalId, 80)}" (or a goal above it) can change it; managers propose with propose_goal.`);
  }

  /**
   * Where a Town Hall item routes (docs/goals.md "Routing"): a grant proposal or checkpoint to its key result's goal, a
   * goal proposal to its target or parent, a rollup to the building's attachment; the item goes to that goal's owner.
   */
  route(item: { grantId?: string; proposalId?: string; buildingId?: string }): { goalId: string; userId: string | null } {
    let goalId: string = ROOT_GOAL_ID;
    if (item.grantId) {
      const g = this.world.grants.get(item.grantId);
      const kr = g?.keyResultId ? this.world.keyResults.get(g.keyResultId) : undefined;
      goalId = kr?.goalId ?? (g ? this.attachmentOf(g.buildingId) : ROOT_GOAL_ID);
    } else if (item.proposalId) {
      const p = this.world.goalProposals.get(item.proposalId);
      goalId = (p && this.nodeOfProposal(p)) ?? ROOT_GOAL_ID;
    } else if (item.buildingId) goalId = this.attachmentOf(item.buildingId);
    return this.ownerOf(goalId);
  }

  // ---- the tree ----
  /** The whole tree from the root (retired goals left out unless asked). */
  tree(opts: { retired?: boolean } = {}): GoalNode {
    const goals = this.world.goals.all();
    const byParent = new Map<string, Goal[]>();
    for (const g of goals) {
      if (!g.parentId || (!opts.retired && g.status === "retired")) continue;
      byParent.set(g.parentId, [...(byParent.get(g.parentId) ?? []), g]);
    }
    const live = new Map(this.world.grants.where("status IN ('funded', 'checkpoint') AND keyResultId IS NOT NULL", [], "ORDER BY fundedAt, rowid").map((g) => [g.keyResultId!, g.id]));
    const krs = new Map<string, (KeyResult & { grantId: string | null })[]>();
    for (const k of this.world.keyResults.where("goalId IS NOT NULL", [], "ORDER BY position, rowid")) krs.set(k.goalId!, [...(krs.get(k.goalId!) ?? []), { ...k, grantId: live.get(k.id) ?? null }]);
    const attached = new Map<string, { id: string; name: string }[]>();
    for (const b of this.world.buildings.all()) {
      const at = this.attachmentOf(b);
      attached.set(at, [...(attached.get(at) ?? []), { id: b.id, name: b.name }]);
    }
    const names = new Map<string, string>();
    const ownerName = (id: string | null) => {
      if (!id) return "the town admins";
      if (!names.has(id)) names.set(id, this.world.users.get(id)?.name ?? id);
      return names.get(id)!;
    };
    const node = (g: Goal, inherited: { goalId: string; userId: string | null }): GoalNode => {
      const owner = g.ownerId ? { goalId: g.id, userId: g.ownerId } : inherited;
      const kids = (byParent.get(g.id) ?? []).sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
      return {
        ...g, owner: { ...owner, name: ownerName(owner.userId) }, buildings: attached.get(g.id) ?? [], keyResults: krs.get(g.id) ?? [],
        children: kids.map((c) => node(c, owner)),
      };
    };
    return node(this.root(), { goalId: ROOT_GOAL_ID, userId: null });
  }

  // ---- editing (admins, or the owner within their subtree) ----
  create(actor: Actor, input: CreateGoalInput): Goal {
    const inp = CreateGoalInput.parse(input);
    const parent = this.requireActive(inp.parentId);
    this.requireEdit(actor, parent.id);
    this.requireSources(inp.sourceDocIds);
    const last = this.world.goals.first("parentId = ?", [parent.id], "ORDER BY position DESC");
    const now = nowIso();
    const by = actor ? holderOf(actor).id : null;
    const g = this.world.goals.upsert({
      id: newId("gl"), parentId: parent.id, position: inp.position ?? (last ? last.position + 1 : 0), text: inp.text, ownerId: null, status: "active",
      retiredAt: null, retiredBy: null, retiredNote: "", createdBy: by, editedBy: null, sourceDocIds: inp.sourceDocIds, createdAt: now, updatedAt: now,
    });
    this.event("goal.created", actor, `Goal added under "${clip(parent.text, 60)}": ${g.text}`, { goalId: g.id, parentId: parent.id, text: g.text });
    return g;
  }

  /** Words, order, a move (parentId) or the owner (ownerId: a user; set by an admin or the owner of a goal above it). */
  update(actor: Actor, id: string, input: UpdateGoalInput): Goal {
    const inp = UpdateGoalInput.parse(input);
    const g = this.requireActive(id);
    const by = actor ? holderOf(actor).id : null;
    let next = g;
    if (inp.text !== undefined || inp.position !== undefined || inp.sourceDocIds !== undefined) {
      this.requireEdit(actor, g.id);
      if (inp.sourceDocIds) this.requireSources(inp.sourceDocIds);
      next = this.world.goals.upsert({ ...next, ...(inp.text !== undefined && { text: inp.text }), ...(inp.position !== undefined && { position: inp.position }), ...(inp.sourceDocIds !== undefined && { sourceDocIds: inp.sourceDocIds }), editedBy: by, updatedAt: nowIso() });
      // the root is the town goal
      if (g.id === ROOT_GOAL_ID && inp.text !== undefined) this.world.town.set({ goal: inp.text });
      this.event("goal.edited", actor, `Goal edited: ${next.text}`, { goalId: g.id, text: next.text, fromText: g.text, position: next.position });
    }
    if (inp.parentId !== undefined && inp.parentId !== g.parentId) next = this.move(actor, next, inp.parentId);
    if (inp.ownerId !== undefined && inp.ownerId !== g.ownerId) {
      if (g.id === ROOT_GOAL_ID) throw badRequest("The root is owned by the town admins.");
      // owners set owners below them: the goal above must be theirs
      this.requireEdit(actor, g.parentId!);
      if (inp.ownerId && !this.world.users.get(inp.ownerId)) throw badRequest(`Owners are humans: ${inp.ownerId} is not a user id.`);
      next = this.world.goals.upsert({ ...next, ownerId: inp.ownerId, editedBy: by, updatedAt: nowIso() });
      const name = inp.ownerId ? this.world.users.get(inp.ownerId)!.name : "(inherited)";
      this.event("goal.owned", actor, `${name} owns "${clip(next.text, 80)}"`, { goalId: g.id, ownerId: inp.ownerId, fromOwnerId: g.ownerId });
    }
    if (next === g) throw badRequest("Nothing to change: give text, position, parentId, ownerId or sourceDocIds.");
    return next;
  }

  private move(actor: Actor, g: Goal, parentId: string): Goal {
    if (g.id === ROOT_GOAL_ID) throw badRequest("The root can't move.");
    const parent = this.requireActive(parentId);
    if (this.subtreeIds(g.id).has(parent.id)) throw badRequest("A goal can't move under itself or one of its own children.");
    this.requireEdit(actor, g.parentId!);
    this.requireEdit(actor, parent.id);
    const last = this.world.goals.first("parentId = ?", [parent.id], "ORDER BY position DESC");
    const next = this.world.goals.upsert({ ...g, parentId: parent.id, position: last ? last.position + 1 : 0, editedBy: actor ? holderOf(actor).id : null, updatedAt: nowIso() });
    this.event("goal.moved", actor, `Goal moved under "${clip(parent.text, 60)}": ${g.text}`, { goalId: g.id, parentId: parent.id, fromParentId: g.parentId });
    return next;
  }

  /**
   * Retire a goal (and everything under it). Its open key results (with their grants) and the buildings attached under it
   * move to `moveTo`, a sibling; with any of them left and no sibling picked, it is refused, so nothing is orphaned.
   */
  retire(actor: Actor, id: string, input: RetireGoalInput = {}): Goal {
    const inp = RetireGoalInput.parse(input);
    const g = this.requireActive(id);
    if (g.id === ROOT_GOAL_ID) throw badRequest("The root can't be retired.");
    this.requireEdit(actor, g.id);
    const sub = this.subtreeIds(g.id);
    const open = this.world.keyResults.where("goalId IS NOT NULL").filter((k) => sub.has(k.goalId!) && isOpenKr(k));
    const attached = this.world.buildings.all().filter((b) => sub.has(this.attachmentOf(b)));
    let to: Goal | undefined;
    if (inp.moveTo) {
      to = this.requireActive(inp.moveTo);
      if (to.parentId !== g.parentId || to.id === g.id) throw badRequest(`${inp.moveTo} is not a sibling of the goal being retired: pick one under "${clip(this.get(g.parentId!)?.text ?? "", 60)}".`);
      this.requireEdit(actor, to.id);
    } else if (open.length || attached.length) {
      throw new AppError("conflict", `Retiring "${clip(g.text, 80)}" would orphan ${[open.length && `${open.length} open key result${open.length === 1 ? "" : "s"} (${open.map((k) => k.id).join(", ")})`, attached.length && `${attached.length} attached building${attached.length === 1 ? "" : "s"} (${attached.map((b) => b.name).join(", ")})`].filter(Boolean).join(" and ")}: pick a sibling to move them to (moveTo), or move or close them first.`);
    }
    const by = actor ? holderOf(actor).id : null;
    const now = nowIso();
    return this.world.transaction(() => {
      for (const k of open) {
        this.world.keyResults.upsert({ ...k, goalId: to!.id, updatedAt: now });
        this.world.events.append({ type: "kr.updated", agentId: actor?.id ?? null, buildingId: k.buildingId, text: `Key result moved to "${clip(to!.text, 60)}": ${k.text}`, payload: { keyResultId: k.id, status: k.status, from: k.status, goalId: to!.id, fromGoalId: k.goalId, by: by ?? "system", edited: false } });
      }
      for (const b of attached) this.setAttachment(actor, b, to!.id);
      for (const gid of sub) {
        const x = this.world.goals.get(gid);
        if (x && x.status === "active") this.world.goals.upsert({ ...x, status: "retired", retiredAt: now, retiredBy: by, retiredNote: inp.note, updatedAt: now });
      }
      this.event("goal.retired", actor, `Goal retired: ${g.text}`, { goalId: g.id, moveTo: to?.id ?? null, movedKeyResults: open.map((k) => k.id), movedBuildings: attached.map((b) => b.id), note: inp.note });
      return this.require(g.id);
    });
  }

  /** Attach a building to a goal (its one attachment; never unset): `goals.edit` on both the old and the new goal. */
  attach(actor: Actor, buildingId: string, goalId: string): Building {
    const b = this.world.buildings.require(buildingId, "building");
    if (!goalId) throw badRequest("A building is always attached to a goal: pick one.");
    const to = this.requireActive(goalId);
    if (b.goalId === to.id) return b;
    if (actor) {
      // a human; the building's own manager agent can't move it
      if (holderOf(actor).kind !== "user") throw forbidden("goals.edit", "Only a human attaches a building to a goal; propose it instead.");
      this.requireEdit(actor, this.attachmentOf(b));
      this.requireEdit(actor, to.id);
    }
    return this.setAttachment(actor, b, to.id);
  }

  private setAttachment(actor: Actor, b: Building, goalId: string): Building {
    const next = this.world.buildings.upsert({ ...b, goalId });
    this.world.events.append({
      type: "goal.attached", agentId: actor?.id ?? null, buildingId: b.id, text: `${b.name} attached to "${clip(this.get(goalId)?.text ?? goalId, 80)}"`,
      payload: { goalId, fromGoalId: b.goalId ?? null, by: actor ? holderOf(actor).id : "system" },
    });
    this.world.grantDesk.syncBlocked(b.id);
    return next;
  }

  /** A dated key result under a goal (`goals.edit` there). `buildingId`: the building it is for (default: the first attached in its path). */
  addKeyResult(actor: Actor, goalId: string, input: CreateTreeKeyResultInput): KeyResult {
    const inp = CreateTreeKeyResultInput.parse(input);
    const g = this.requireActive(goalId);
    this.requireEdit(actor, g.id);
    this.requireSources(inp.sourceDocIds);
    const buildingId = inp.buildingId ?? this.buildingNear(g.id);
    if (!buildingId) throw badRequest("No building is attached at or above this goal: give buildingId (the building it is for).");
    return this.createKr(actor, { goalId: g.id, buildingId, text: inp.text, howToCheck: inp.howToCheck, due: inp.due, sourceDocIds: inp.sourceDocIds });
  }

  private createKr(actor: Actor, f: { goalId: string; buildingId: string; text: string; howToCheck: string; due: string | null; sourceDocIds: string[] }): KeyResult {
    const b = this.world.buildings.require(f.buildingId, "building");
    const by = actor ? holderOf(actor) : null;
    const last = this.world.keyResults.first("buildingId = ?", [b.id], "ORDER BY position DESC");
    const kr = this.world.keyResults.upsert({
      id: newId("kr"), buildingId: b.id, position: last ? last.position + 1 : 0, text: f.text, howToCheck: f.howToCheck, status: "not-started", statusNote: "", statusBy: null,
      createdBy: by?.id ?? null, editedBy: null, sourceDocIds: f.sourceDocIds, objectiveId: this.world.objectives.get(f.goalId) ? f.goalId : null,
      goalId: f.goalId, due: f.due, archivedAt: null, underReviewSince: null, postmortemDocId: null, updatedAt: nowIso(),
    });
    this.world.events.append({
      type: "kr.created", agentId: actor?.id ?? null, buildingId: b.id, text: `Key result under "${clip(this.get(f.goalId)?.text ?? "", 60)}": ${kr.text}`,
      payload: { keyResultId: kr.id, by: by?.id ?? "system", byKind: by?.kind ?? "system", text: kr.text, howToCheck: kr.howToCheck, sourceDocIds: kr.sourceDocIds, goalId: f.goalId, due: f.due },
    });
    return kr;
  }

  /** The first building attached at the goal or the nearest goal above it. */
  private buildingNear(goalId: string): string | null {
    for (const g of this.ancestors(goalId)) {
      const b = this.world.buildings.first("goalId = ? AND kind != 'town-hall'", [g.id], "ORDER BY createdAt, rowid");
      if (b) return b.id;
    }
    return null;
  }

  // ---- proposals (managers and their forks; a human accepts or cuts) ----
  /** `propose_goal` / `propose_key_result`: a change to the tree for a human to accept or cut. A newer one on the same target supersedes the older. */
  propose(actor: Actor, input: ProposeGoalInput): GoalProposalView {
    const inp = ProposeGoalInput.parse(input);
    const by = actor ? holderOf(actor) : { kind: "user" as const, id: "system" };
    // the Planner (a Town Hall resident) proposes for no building (docs/goals.md "The planning agent")
    const planner = this.world.reorgs.isPlanner(actor);
    const buildingId = planner ? null : inp.buildingId ?? (actor && "homeBuildingId" in actor ? actor.homeBuildingId ?? null : null);
    if (buildingId) this.world.buildings.require(buildingId, "building");
    if (inp.reorgId) {
      const c = this.world.goalChanges.get(inp.reorgId);
      if (!c) throw badRequest(`${inp.reorgId} is not a "Change this goal" (gc_…).`);
      if (c.status === "decided") throw badRequest(`Change ${c.id} is already decided; propose without reorgId.`);
    }
    // managers and their forks propose for their building; humans may too
    if (actor && by.kind !== "user" && !planner) {
      const b = buildingId ? this.world.buildings.get(buildingId) : undefined;
      const manager = this.world.permissions.managerOfFork(actor)?.id ?? actor.id;
      if (!b || b.managerAgentId !== manager) throw forbidden("building.manage", "Only a building's manager (or its fork) proposes goal changes for it.");
    }
    const fields: Record<string, string> = {};
    if (inp.text) fields.text = inp.text;
    if (inp.howToCheck) fields.howToCheck = inp.howToCheck;
    if (inp.due) fields.due = inp.due;
    const kr = inp.targetId ? this.world.keyResults.get(inp.targetId) : undefined;
    switch (inp.action) {
      case "add-goal":
        if (!inp.parentId || !inp.text) throw badRequest("add-goal needs parentId (the goal it goes under) and text.");
        this.requireActive(inp.parentId);
        break;
      case "add-kr":
        if (!inp.parentId || !inp.text || !inp.howToCheck || !inp.due) throw badRequest("add-kr needs parentId (its goal), text, howToCheck and due (YYYY-MM-DD).");
        this.requireActive(inp.parentId);
        break;
      case "edit":
        if (!inp.targetId || !Object.keys(fields).length) throw badRequest("edit needs targetId (a goal or key result) and the new text (and for a key result howToCheck or due).");
        if (!kr) this.requireActive(inp.targetId);
        break;
      case "move":
        if (!inp.targetId || !inp.parentId) throw badRequest("move needs targetId (a goal or key result) and parentId (where it goes).");
        if (!kr) this.requireActive(inp.targetId);
        this.requireActive(inp.parentId);
        break;
      case "retire":
        if (!inp.targetId || kr) throw badRequest("retire needs targetId (a goal); a sibling to move its open key results to goes in parentId.");
        this.requireActive(inp.targetId);
        break;
      case "promote":
        if (!kr) throw badRequest("promote needs targetId (a key result to turn into a goal).");
        break;
    }
    const now = nowIso();
    const p = this.world.transaction(() => {
      if (inp.targetId) {
        for (const old of this.world.goalProposals.where("status = 'open' AND action = ? AND targetId = ? AND buildingId IS ?", [inp.action, inp.targetId, buildingId])) {
          this.world.goalProposals.upsert({ ...old, status: "superseded", decidedAt: now });
        }
      }
      return this.world.goalProposals.upsert({
        id: newId("gp"), action: inp.action, targetId: inp.targetId ?? null, parentId: inp.parentId ?? null, fields, why: inp.why, proposedBy: by.id,
        buildingId, reorgId: inp.reorgId ?? null, sourceDocIds: inp.sourceDocIds, status: "open", decidedBy: null, decidedAt: null, note: "", resultId: null, createdAt: now,
      });
    });
    const view = this.proposalView(p);
    this.world.events.append({ type: "goal.proposal", agentId: actor?.id ?? null, buildingId, text: `Goal proposal (${p.action}): ${clip(fields.text ?? this.targetText(p), 100)}`, payload: { proposalId: p.id, action: p.action, status: p.status, outsideScope: view.outsideScope } });
    this.notifyEditors(p, actor, `${view.proposedByName} proposed a change to the goal tree (${p.action}): ${clip(fields.text ?? this.targetText(p), 160)}. Why: ${clip(p.why, 300)}. Accept or cut it (${p.id}).`);
    return view;
  }

  listProposals(opts: { status?: GoalProposal["status"]; buildingId?: string } = {}): GoalProposalView[] {
    const where = [opts.status && "status = ?", opts.buildingId && "buildingId = ?"].filter(Boolean).join(" AND ") || "1 = 1";
    const params = [opts.status, opts.buildingId].filter((x): x is string => !!x);
    return this.world.goalProposals.where(where, params, "ORDER BY createdAt, rowid").map((p) => this.proposalView(p));
  }

  /** Accept (with optional edited words) or cut a proposal: a human with `goals.edit` where it lands. Cutting tells the proposer. */
  decideProposal(actor: Actor, id: string, input: DecideGoalProposalInput): GoalProposalView {
    const inp = DecideGoalProposalInput.parse(input);
    const p = this.world.goalProposals.require(id, "goal proposal");
    if (p.status !== "open") throw new AppError("conflict", `This proposal is already ${p.status}.`);
    if (actor && holderOf(actor).kind !== "user") throw forbidden("goals.edit", "Only a human accepts or cuts a goal proposal.");
    const node = this.nodeOfProposal(p);
    if (node) this.requireEdit(actor, node);
    const by = actor ? holderOf(actor).id : "system";
    const next = this.world.transaction(() => {
      let resultId: string | null = null;
      if (inp.action === "accept") resultId = this.apply(actor, p, { ...p.fields, ...(inp.text && { text: inp.text }), ...(inp.howToCheck && { howToCheck: inp.howToCheck }), ...(inp.due && { due: inp.due }) });
      return this.world.goalProposals.upsert({ ...p, status: inp.action === "accept" ? "accepted" : "cut", decidedBy: by, decidedAt: nowIso(), note: inp.note, resultId });
    });
    this.world.events.append({ type: "goal.proposal", agentId: actor?.id ?? null, buildingId: p.buildingId, text: `Goal proposal ${next.status}: ${clip(p.fields.text ?? this.targetText(p), 100)}`, payload: { proposalId: p.id, action: p.action, status: next.status, resultId: next.resultId } });
    if (this.world.agents.get(p.proposedBy)) {
      sendMessage(this.world, { kind: "system", fromId: by, fromKind: actor ? holderOf(actor).kind : "system", toId: p.proposedBy, body: `Your goal proposal ${p.id} (${p.action}: ${clip(p.fields.text ?? this.targetText(p), 120)}) was ${next.status}${inp.note ? `: ${inp.note}` : "."}` });
    }
    return this.proposalView(next);
  }

  /** Make the change an accepted proposal describes (as the deciding human); returns the goal or key result it made or changed. */
  private apply(actor: Actor, p: GoalProposal, f: Record<string, string>): string {
    const kr = p.targetId ? this.world.keyResults.get(p.targetId) : undefined;
    const sources = p.sourceDocIds.filter((d) => { const doc = this.world.docs.get(d); return doc && doc.state !== "draft"; });
    switch (p.action) {
      case "add-goal": return this.create(actor, { parentId: p.parentId!, text: f.text, sourceDocIds: sources }).id;
      case "add-kr": return this.createKr(actor, { goalId: this.requireActive(p.parentId!).id, buildingId: p.buildingId ?? this.buildingNear(p.parentId!) ?? "", text: f.text, howToCheck: f.howToCheck, due: f.due ?? null, sourceDocIds: sources }).id;
      case "edit":
        if (kr) return this.world.grantDesk.updateKeyResult(null, kr.id, { ...(f.text && { text: f.text }), ...(f.howToCheck && { howToCheck: f.howToCheck }), ...(f.due && { due: f.due }) }).id;
        return this.update(actor, p.targetId!, { text: f.text }).id;
      case "move":
        if (kr) return this.moveKr(actor, kr, p.parentId!).id;
        return this.update(actor, p.targetId!, { parentId: p.parentId! }).id;
      case "retire": return this.retire(actor, p.targetId!, { moveTo: p.parentId ?? undefined }).id;
      case "promote": {
        if (!kr) throw badRequest(`${p.targetId} is not a key result.`);
        const g = this.create(actor, { parentId: kr.goalId ?? ROOT_GOAL_ID, text: f.text ?? kr.text, sourceDocIds: sources });
        this.moveKr(actor, kr, g.id);
        return g.id;
      }
    }
  }

  /** Move a key result under another goal (its grants go with it). */
  moveKr(actor: Actor, kr: KeyResult, goalId: string): KeyResult {
    const to = this.requireActive(goalId);
    if (kr.goalId) this.requireEdit(actor, kr.goalId);
    this.requireEdit(actor, to.id);
    const next = this.world.keyResults.upsert({ ...kr, goalId: to.id, objectiveId: this.world.objectives.get(to.id) ? to.id : null, updatedAt: nowIso() });
    this.world.events.append({ type: "kr.updated", agentId: actor?.id ?? null, buildingId: kr.buildingId, text: `Key result moved to "${clip(to.text, 60)}": ${kr.text}`, payload: { keyResultId: kr.id, status: kr.status, from: kr.status, goalId: to.id, fromGoalId: kr.goalId, by: actor ? holderOf(actor).id : "system", edited: false } });
    return next;
  }

  // ---- history (the editor's History tab: the event log is the audit trail) ----
  /**
   * A goal's history, newest first: its own goal.* events, its key results' kr.* events, buildings attached to or moved
   * off it, and goal proposals that name it. No audit table: these are the event log's rows.
   */
  history(goalId: string, limit = 100): Event[] {
    this.require(goalId);
    const krIds = this.world.keyResults.where("goalId = ?", [goalId]).map((k) => k.id);
    const proposalIds = this.world.goalProposals.where("targetId = ? OR parentId = ?", [goalId, goalId]).map((p) => p.id);
    const inList = (n: number) => n ? `IN (${Array(n).fill("?").join(",")})` : "IN (NULL)";
    const rows = this.world.db.prepare(
      `SELECT * FROM events WHERE (type LIKE 'goal.%' AND (json_extract(payload, '$.goalId') = ? OR json_extract(payload, '$.fromGoalId') = ? OR json_extract(payload, '$.parentId') = ?))
        OR (type LIKE 'kr.%' AND (json_extract(payload, '$.keyResultId') ${inList(krIds.length)} OR json_extract(payload, '$.goalId') = ? OR json_extract(payload, '$.fromGoalId') = ?))
        OR (type = 'goal.proposal' AND json_extract(payload, '$.proposalId') ${inList(proposalIds.length)})
       ORDER BY id DESC LIMIT ${Math.min(Math.max(limit, 1), 500)}`,
    ).all(goalId, goalId, goalId, ...krIds, goalId, goalId, ...proposalIds) as Record<string, unknown>[];
    return rows.map((r) => Event.parse({ ...r, payload: JSON.parse(String(r.payload ?? "{}")) }));
  }

  // ---- boot ----
  /** Boot repair (idempotent): the root exists, and every building is attached (a null attachment goes to the root). */
  ensure(): void {
    if (!this.get(ROOT_GOAL_ID)) {
      const now = nowIso();
      this.world.goals.upsert({ id: ROOT_GOAL_ID, parentId: null, position: 0, text: this.world.town.get().goal || "The town goal", ownerId: null, status: "active", retiredAt: null, retiredBy: null, retiredNote: "", createdBy: null, editedBy: null, sourceDocIds: [], createdAt: now, updatedAt: now });
    }
    for (const b of this.world.buildings.where("goalId IS NULL OR goalId NOT IN (SELECT id FROM goals)")) this.world.buildings.upsert({ ...b, goalId: ROOT_GOAL_ID });
  }

  // ---- helpers ----
  private requireActive(id: string): Goal {
    const g = this.require(id);
    if (g.status !== "active") throw badRequest(`Goal ${id} is retired.`);
    return g;
  }

  /** The goal a proposal lands on: its target (a key result's goal), else its parent; `goals.edit` there decides it. */
  nodeOfProposal(p: GoalProposal): string | null {
    if (p.targetId) {
      const kr = this.world.keyResults.get(p.targetId);
      if (kr) return kr.goalId ?? null;
      if (this.get(p.targetId)) return p.targetId;
    }
    return p.parentId && this.get(p.parentId) ? p.parentId : null;
  }

  private proposalView(p: GoalProposal): GoalProposalView {
    const node = this.nodeOfProposal(p);
    const scope = p.buildingId ? this.scopeOf(p.buildingId) : null;
    const outside = !!scope && ([node, p.parentId].filter((x): x is string => !!x).some((x) => !scope.has(x)));
    return { ...p, proposedByName: this.world.nameOf(p.proposedBy), outsideScope: outside };
  }

  private targetText(p: GoalProposal): string {
    const t = p.targetId ? this.world.keyResults.get(p.targetId)?.text ?? this.get(p.targetId)?.text : undefined;
    return t ?? p.targetId ?? "";
  }

  /** Inbox note to every human (avatar) who can accept the proposal. */
  private notifyEditors(p: GoalProposal, actor: Actor, body: string): void {
    const node = this.nodeOfProposal(p) ?? ROOT_GOAL_ID;
    const from: Holder | { kind: "system"; id: string } = actor ? holderOf(actor) : { kind: "system", id: "system" };
    for (const h of this.world.agents.where("kind = 'human' AND status != 'retired'")) {
      if (h.id === actor?.id || !this.canEdit(h, node)) continue;
      sendMessage(this.world, { kind: "system", fromId: from.id, fromKind: from.kind, toId: h.id, body });
    }
  }

  private requireSources(ids: string[]): void {
    for (const id of ids) {
      const d = this.world.docs.get(id);
      if (!d || d.state === "draft") throw badRequest(`Source ${id} is not a published document (meeting notes or a report).`);
    }
  }

  private event(type: "goal.created" | "goal.edited" | "goal.moved" | "goal.retired" | "goal.owned", actor: Actor, text: string, payload: Record<string, unknown>): void {
    this.world.events.append({ type, agentId: actor?.id ?? null, buildingId: null, text, payload: { ...payload, by: actor ? holderOf(actor).id : "system" } });
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
