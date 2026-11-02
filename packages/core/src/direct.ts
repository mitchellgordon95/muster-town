/**
 * "Direct work under <goal>" (grant gr_cuobjlny6r, Mitchell mt_hlizi9wxxc decision 1). Members and captains get the same
 * 1:1 and meeting experience; who may hold one in a building, and be the human source of its directed work, is one
 * check, `canDirect`: the building's staff (meeting.facilitate or building.review there), a captain of the building's
 * attachment goal or a goal above it, or a let-in member holding a `direct_grants` row for that goal or one above it.
 * No permission, no 1:1. An admin or a captain over the goal grants it (at Let in, or later from User stats) and revokes it.
 */
import type { Agent } from "@muster-town/schema";
import { canInteract } from "./access.ts";
import { AppError, badRequest, forbidden } from "./errors.ts";
import { holderOf, townRoleId, type Holder } from "./permissions.ts";
import { oneLine } from "./text.ts";
import { nowIso } from "./util.ts";
import type { World } from "./world.ts";

export interface DirectGrant { userId: string; goalId: string; grantedBy: string; createdAt: string }
/** A let-in member as GET /api/members lists them (User stats' Members table). */
export interface MemberView {
  userId: string; name: string; githubLogin: string | null; avatarUrl: string | null;
  /** when they were let in (their granted access request), null for a member made another way */
  letInAt: string | null;
  /** the goals they may direct work under (none = no 1:1s) */
  direct: { goalId: string; text: string; grantedBy: string; createdAt: string }[];
}

/** The user's direct-work rows, oldest first. */
export function directGrantsOf(world: World, userId: string): DirectGrant[] {
  return world.db.prepare("SELECT * FROM direct_grants WHERE userId = ? ORDER BY createdAt, rowid").all(userId) as DirectGrant[];
}

/** May this human (or agent) open 1:1s and meetings in the building and be the human source of its directed work? */
export function canDirect(world: World, who: Agent | Holder, buildingId: string): boolean {
  if (world.permissions.can(who, "meeting.facilitate", buildingId) || world.permissions.can(who, "building.review", buildingId)) return true;
  const h = holderOf(who);
  if (h.kind !== "user") return false;
  const goals = world.goalTree.ancestors(world.goalTree.attachmentOf(buildingId));
  if (goals.some((g) => g.ownerId === h.id)) return true;
  if (!canInteract(world, h.id)) return false;
  const held = new Set(directGrantsOf(world, h.id).map((r) => r.goalId));
  return goals.some((g) => held.has(g.id));
}

/** May the actor grant or revoke "direct work under" this goal? An admin, or a captain of the goal or one above it. */
export function canGrantDirect(world: World, actor: Agent | Holder, goalId: string): boolean {
  if (world.permissions.can(actor, "town.manage_roles")) return true;
  const h = holderOf(actor);
  return h.kind === "user" && world.goalTree.ancestors(goalId).some((g) => g.ownerId === h.id);
}

/** The goal the Let in card offers by default: the decider's captained goal (the first), else the town goal for an admin; null otherwise. */
export function defaultDirectGoal(world: World, actor: Agent | Holder): string | null {
  const h = holderOf(actor);
  if (h.kind !== "user") return null;
  const captained = world.goals.first("ownerId = ? AND status = 'active'", [h.id], "ORDER BY createdAt, rowid");
  if (captained) return captained.id;
  return world.permissions.isAdmin(h) ? world.goalTree.root().id : null;
}

/** Let a member direct work under the goal. Idempotent (an existing row is returned as it is). */
export function grantDirect(world: World, actor: Agent | Holder, userId: string, goalId: string): DirectGrant {
  const goal = world.goalTree.get(goalId);
  if (!goal) throw badRequest(`Unknown goal ${goalId}.`);
  if (goal.status !== "active") throw badRequest(`Goal ${goalId} is retired.`);
  if (!canGrantDirect(world, actor, goalId)) throw forbidden("goals.edit", `Only an admin or the captain of "${oneLine(goal.text, 80)}" (or a goal above it) can let someone direct work under it.`);
  world.users.require(userId, "user");
  if (!canInteract(world, userId)) throw new AppError("conflict", "Let them in first: only a member can direct work.");
  const existing = world.db.prepare("SELECT * FROM direct_grants WHERE userId = ? AND goalId = ?").get(userId, goalId) as DirectGrant | undefined;
  if (existing) return existing;
  const row: DirectGrant = { userId, goalId, grantedBy: holderOf(actor).id, createdAt: nowIso() };
  world.db.prepare("INSERT INTO direct_grants (userId, goalId, grantedBy, createdAt) VALUES (?, ?, ?, ?)").run(row.userId, row.goalId, row.grantedBy, row.createdAt);
  world.events.append({ type: "system", text: `${who(world, userId)} may direct work under "${oneLine(goal.text, 120)}"`, payload: { userId, goalId, by: row.grantedBy, direct: true } });
  return row;
}

/** Take it back. Returns whether a row was removed (a missing one is not an error). */
export function revokeDirect(world: World, actor: Agent | Holder, userId: string, goalId: string): boolean {
  const goal = world.goalTree.get(goalId);
  if (!goal) throw badRequest(`Unknown goal ${goalId}.`);
  if (!canGrantDirect(world, actor, goalId)) throw forbidden("goals.edit", `Only an admin or the captain of "${oneLine(goal.text, 80)}" (or a goal above it) can change who directs work under it.`);
  const removed = world.db.prepare("DELETE FROM direct_grants WHERE userId = ? AND goalId = ?").run(userId, goalId).changes > 0;
  if (removed) world.events.append({ type: "system", text: `${who(world, userId)} may no longer direct work under "${oneLine(goal.text, 120)}"`, payload: { userId, goalId, by: holderOf(actor).id, direct: false } });
  return removed;
}

/** Let-in members (town `member` role), with when they were let in and the goals they may direct work under. */
export function membersView(world: World): MemberView[] {
  return world.memberships.forRole(townRoleId("member")).filter((m) => m.holderKind === "user").flatMap((m) => {
    const u = world.users.get(m.holderId);
    if (!u) return [];
    const req = world.accessRequests.first("userId = ? AND status = 'granted'", [u.id], "ORDER BY decidedAt DESC, rowid DESC");
    const direct = directGrantsOf(world, u.id).map((r) => ({ goalId: r.goalId, text: world.goalTree.get(r.goalId)?.text ?? r.goalId, grantedBy: r.grantedBy, createdAt: r.createdAt }));
    return [{ userId: u.id, name: u.name, githubLogin: u.githubLogin ?? null, avatarUrl: u.avatarUrl ?? null, letInAt: req?.decidedAt ?? null, direct }];
  });
}

function who(world: World, userId: string): string {
  const u = world.users.get(userId);
  return u?.githubLogin ? `@${u.githubLogin}` : u?.name ?? userId;
}
