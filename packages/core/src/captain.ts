/**
 * "Ask to captain this goal" (grant gr_bwm0iz7rwl, kr_j1w17nw178). A goal's captain is its `ownerId` (docs/goals.md
 * "Captains on nodes"; "captain" is the word humans see). A member (`town.interact`) asks to captain a goal; the request
 * waits in the Town Hall in-tray, routed to the goal's current captain (its own, else inherited from the nearest
 * captained ancestor; the root always has one, so a request about the root itself goes to the root's captain). That captain, an admin, or a captain higher up (`goals.edit` at the
 * goal) accepts, which sets `ownerId` through `Goals.setOwner` (the same path as the Captain tool), or declines.
 * Any signed-in user may ask (gr_y9bpvx197c: captaining is one of the three doors, open before being let in); accepting
 * a non-member's request also lets them in as `member` (Mitchell, dc_n6z1gg5d62), closing their pending join request.
 * One pending request per (goal, user). Modeled on access.ts.
 */
import { type Agent, type CaptainRequest, type CaptainRequestView } from "@muster-town/schema";
import { accessRequestOf, canInteract } from "./access.ts";
import { countFunnelDecision } from "./join-funnel.ts";
import { askForCaptain, retireAsks } from "./asks.ts";
import { AppError, badRequest, forbidden } from "./errors.ts";
import { holderOf, townRoleId } from "./permissions.ts";
import { newId, nowIso } from "./util.ts";
import type { World } from "./world.ts";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Any signed-in user asks to captain a goal. A pending request by the same user for the same goal is refused (409). */
export function requestCaptain(world: World, userId: string, goalId: string, note = ""): CaptainRequest {
  const user = world.users.require(userId, "user");
  const goal = world.goalTree.require(goalId);
  if (goal.status !== "active") throw badRequest(`Goal ${goalId} is retired.`);
  if (goal.ownerId === userId) throw new AppError("conflict", "You already captain this goal.");
  if (world.captainRequests.first("goalId = ? AND userId = ? AND status = 'pending'", [goalId, userId])) {
    throw new AppError("conflict", "You already asked to captain this goal; it is waiting for a decision.");
  }
  const req = world.captainRequests.upsert({
    id: newId("cr"), goalId, userId, note: note.trim().slice(0, 280), status: "pending", decidedBy: null, decisionNote: "", createdAt: nowIso(), decidedAt: null,
  });
  world.events.append({
    type: "system", text: `${nameOf(world, userId, user.name)} asks to captain "${clip(goal.text, 80)}"${req.note ? `: "${req.note}"` : ""}`,
    payload: { captainRequestId: req.id, goalId, userId },
  });
  askForCaptain(world, req);
  emitTownHall(world);
  return req;
}

/** May this actor decide a captain request on the goal? A human with `goals.edit` there: an admin, its captain, or a captain above it. */
export function canDecideCaptain(world: World, actor: Agent | undefined, goalId: string): boolean {
  if (!actor || holderOf(actor).kind !== "user") return false;
  return world.goalTree.canEdit(actor, goalId);
}

/** The goal's current captain (or an admin) accepts, setting `ownerId`, or declines, leaving it as it was. Only a pending request. */
export function decideCaptain(world: World, actor: Agent, id: string, accept: boolean, note = ""): CaptainRequest {
  const req = world.captainRequests.require(id, "captain request");
  if (!canDecideCaptain(world, actor, req.goalId)) {
    throw forbidden("goals.edit", "Only the goal's current captain or an admin can decide who captains it.");
  }
  if (req.status !== "pending") throw new AppError("conflict", `This request was already ${req.status}.`);
  const decider = holderOf(actor).id;
  const out = world.transaction(() => {
    if (accept) {
      const goal = world.goalTree.require(req.goalId);
      if (goal.status !== "active") throw badRequest(`Goal ${req.goalId} is retired.`);
      world.goalTree.setOwner(actor, goal, req.userId);
      if (!canInteract(world, req.userId)) letInByCaptain(world, req.userId, decider);
    }
    return world.captainRequests.upsert({ ...req, status: accept ? "accepted" : "declined", decidedBy: decider, decisionNote: note.trim().slice(0, 280), decidedAt: nowIso() });
  });
  const goalText = clip(world.goalTree.get(req.goalId)?.text ?? req.goalId, 80);
  const who = nameOf(world, req.userId);
  const decided = world.events.append({
    type: "system", text: accept ? `${who} now captains "${goalText}"` : `${who}'s request to captain "${goalText}" was declined`,
    payload: { captainRequestId: id, goalId: req.goalId, userId: req.userId, accepted: accept },
  });
  retireAsks(world, "captain", id, decided.text);
  emitTownHall(world);
  return out;
}

/** Pending requests, oldest first, with who asked, the goal's words and its current captain: Town Hall in-tray rows. */
export function pendingCaptainRequests(world: World): CaptainRequestView[] {
  return world.captainRequests.where("status = 'pending'", [], "ORDER BY createdAt, rowid").map((r) => {
    const u = world.users.get(r.userId);
    const goal = world.goalTree.get(r.goalId);
    const captainId = world.goalTree.ownerOf(r.goalId).userId;
    return {
      ...r, name: u?.name ?? r.userId, githubLogin: u?.githubLogin ?? null, avatarUrl: u?.avatarUrl ?? null, goalText: goal?.text ?? r.goalId,
      captainId, captainName: world.users.get(captainId)?.name ?? captainId,
    };
  });
}

/**
 * Accepting a captain request lets a non-member in (Mitchell, dc_n6z1gg5d62): the `member` role, and their pending join
 * request (if any) marked granted by the same decider, counted in the funnel and taken off the in-tray.
 */
function letInByCaptain(world: World, userId: string, decider: string): void {
  world.permissions.ensureTownRoles();
  world.permissions.grant({ kind: "user", id: userId }, townRoleId("member"));
  const ar = accessRequestOf(world, userId);
  if (ar?.status !== "pending") return;
  const decidedAt = nowIso();
  countFunnelDecision(world, true, Date.parse(decidedAt) - Date.parse(ar.createdAt));
  world.accessRequests.upsert({ ...ar, status: "granted", decidedBy: decider, decidedAt });
  retireAsks(world, "access", ar.id, `${nameOf(world, userId)} was let in as a member (captain request accepted)`);
}

export function pendingCaptainCount(world: World): number {
  return world.captainRequests.count("status = 'pending'");
}

function nameOf(world: World, userId: string, fallback?: string): string {
  const u = world.users.get(userId);
  return u?.githubLogin ? `@${u.githubLogin}` : u?.name ?? fallback ?? userId;
}

/** The Town Hall badge counts pending requests: resend the building with its count. */
function emitTownHall(world: World): void {
  const th = world.buildings.first("kind = 'town-hall'");
  if (th) world.changes.emit({ type: "building", building: { ...th, intray: world.ops.intrayCount(th.id) } });
}
