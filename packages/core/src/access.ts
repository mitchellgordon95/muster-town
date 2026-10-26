/**
 * Who may interact (Mitchell's flag dc_hsdvn0h5ho, design dc_f0cumcfubk). Signing in with GitHub makes a user a
 * `visitor`: read-only, like a guest but named. They ask to join once from the guest card; the request waits in the
 * Town Hall in-tray until someone with `town.manage_roles` (an admin) lets them in as `member` (`town.interact`) or
 * declines. A declined user may ask again after `ASK_AGAIN_MS`.
 */
import type { AccessRequest, AccessRequestView } from "@muster-town/schema";
import { AppError, badRequest } from "./errors.ts";
import { townRoleId, type Holder } from "./permissions.ts";
import type { Agent } from "@muster-town/schema";
import { newId, nowIso } from "./util.ts";
import type { World } from "./world.ts";

/** A declined user may ask again after a day (no spam loop). */
export const ASK_AGAIN_MS = 24 * 3600_000;

/** The user's latest access request, or null. */
export function accessRequestOf(world: World, userId: string): AccessRequest | null {
  return world.accessRequests.first("userId = ?", [userId], "ORDER BY createdAt DESC, rowid DESC") ?? null;
}

/** May this user act in the town (`town.interact`)? */
export function canInteract(world: World, userId: string): boolean {
  return world.permissions.can({ kind: "user", id: userId }, "town.interact");
}

/** A signed-in user without `town.interact` asks to join. A pending request is returned as it is (one per user). */
export function requestAccess(world: World, userId: string, message = ""): AccessRequest {
  const user = world.users.require(userId, "user");
  if (canInteract(world, userId)) throw new AppError("conflict", "You can already take part here.");
  const last = accessRequestOf(world, userId);
  if (last?.status === "pending") return last;
  if (last?.status === "declined" && last.decidedAt && Date.now() - Date.parse(last.decidedAt) < ASK_AGAIN_MS) {
    throw new AppError("conflict", `Not this time. You can ask again after ${new Date(Date.parse(last.decidedAt) + ASK_AGAIN_MS).toISOString()}.`);
  }
  const req = world.accessRequests.upsert({ id: newId("ar"), userId, message: message.trim().slice(0, 140), status: "pending", decidedBy: null, createdAt: nowIso(), decidedAt: null });
  const who = user.githubLogin ? `@${user.githubLogin}` : user.name;
  world.events.append({ type: "system", text: `${who} asked to join${req.message ? `: "${req.message}"` : ""}`, payload: { accessRequestId: req.id, userId } });
  emitTownHall(world);
  return req;
}

/** An admin (`town.manage_roles`) lets the person in as `member`, or declines. Only a pending request can be decided. */
export function decideAccess(world: World, actor: Holder | Agent, id: string, grant: boolean): AccessRequest {
  world.permissions.require(actor, "town.manage_roles");
  const req = world.accessRequests.require(id, "access request");
  if (req.status !== "pending") throw new AppError("conflict", `This request was already ${req.status}.`);
  const decider = holderId(world, actor);
  const out = world.transaction(() => {
    if (grant) {
      world.permissions.ensureTownRoles();
      world.permissions.grant({ kind: "user", id: req.userId }, townRoleId("member"));
    }
    return world.accessRequests.upsert({ ...req, status: grant ? "granted" : "declined", decidedBy: decider, decidedAt: nowIso() });
  });
  const user = world.users.get(req.userId);
  const who = user?.githubLogin ? `@${user.githubLogin}` : user?.name ?? req.userId;
  world.events.append({ type: "system", text: grant ? `${who} was let in as a member` : `${who}'s request to join was declined`, payload: { accessRequestId: id, userId: req.userId, granted: grant } });
  emitTownHall(world);
  return out;
}

/** Pending requests, oldest first, with who asked: Town Hall in-tray rows. */
export function pendingAccessRequests(world: World): AccessRequestView[] {
  return world.accessRequests.where("status = 'pending'", [], "ORDER BY createdAt, rowid").map((r) => {
    const u = world.users.get(r.userId);
    return { ...r, name: u?.name ?? r.userId, githubLogin: u?.githubLogin ?? null, avatarUrl: u?.avatarUrl ?? null };
  });
}

export function parseAccessMessage(message: unknown): string {
  if (message == null) return "";
  if (typeof message !== "string") throw badRequest("message must be a string");
  return message;
}

function holderId(world: World, actor: Holder | Agent): string {
  if ("pos" in actor) return actor.kind === "human" && actor.ownerUserId ? actor.ownerUserId : actor.id;
  return actor.id;
}

/** The Town Hall badge counts pending requests: resend the building with its count. */
function emitTownHall(world: World): void {
  const th = world.buildings.first("kind = 'town-hall'");
  if (th) world.changes.emit({ type: "building", building: { ...th, intray: world.ops.intrayCount(th.id) } });
}
