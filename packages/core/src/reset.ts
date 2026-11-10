/**
 * Self-service role reset (town-wide FYI dc_ia2hybtuax, assignment as_oj22fnltuz): a signed-in user puts their own
 * account back to a never-granted stranger, so the next live check on the shared test GitHub account starts clean.
 * It drops every role except the built-in town `visitor`, clears the goals they captain, deletes their access requests
 * (so they can ask to join again at once, as a stranger who never asked), withdraws their pending captain requests and
 * removes their "direct work under" rows, and retires (dismisses) the visitor agents they registered, freeing their
 * desks and revoking their tokens. It keeps what is history: docs, meetings, donations, events, agent rows.
 *
 * Refused for an admin and for the root goal's captain: resetting either could lock a collective out of its own
 * decisions (the root always has a captain, docs/goals.md). Self-service only: nobody resets someone else.
 */
import { NOT_GONE } from "@muster-town/schema";
import { retireAsks } from "./asks.ts";
import { AppError } from "./errors.ts";
import { townRoleId } from "./permissions.ts";
import { nowIso } from "./util.ts";
import type { World } from "./world.ts";

interface ResetResult {
  /** role ids dropped (the visitor role is kept or added) */
  rolesRemoved: string[];
  /** goals whose own captain was this user; they now inherit their captain from above */
  goalsReleased: string[];
  accessRequestsDeleted: number;
  captainRequestsWithdrawn: number;
  directGrantsRemoved: number;
  /** visitor agents of this user that were live and are now retired (the caller runs the runtime's onAgentRetired) */
  agentsRetired: string[];
}

export function resetOwnAccount(world: World, userId: string): ResetResult {
  const user = world.users.require(userId, "user");
  const holder = { kind: "user" as const, id: userId };
  if (world.permissions.isAdmin(holder)) {
    throw new AppError("forbidden", "An admin cannot reset their own account: it could leave the collective without an admin.");
  }
  if (world.goalTree.root().ownerId === userId) {
    throw new AppError("forbidden", "The root goal's captain cannot reset their account: the root always has a captain.");
  }
  const visitor = townRoleId("visitor");
  const out = world.transaction((): ResetResult => {
    world.permissions.ensureTownRoles();
    const rolesRemoved = world.memberships.forHolder("user", userId).map((m) => m.roleId).filter((r) => r !== visitor);
    for (const roleId of rolesRemoved) world.memberships.remove({ roleId, holderKind: "user", holderId: userId });
    world.permissions.grant(holder, visitor);
    const goalsReleased: string[] = [];
    for (const g of world.goals.where("ownerId = ?", [userId], "ORDER BY createdAt, rowid")) {
      world.goalTree.setOwner(world.ops.ensureAvatar(userId), g, null);
      goalsReleased.push(g.id);
    }
    // their pending requests' asks retire with them (docs/legible-delegation.md §4)
    for (const r of world.accessRequests.where("userId = ? AND status = 'pending'", [userId])) retireAsks(world, "access", r.id, "The asker reset their account.");
    for (const r of world.captainRequests.where("userId = ? AND status = 'pending'", [userId])) retireAsks(world, "captain", r.id, "Withdrawn: the asker reset their account.");
    const accessRequestsDeleted = world.db.prepare("DELETE FROM access_requests WHERE userId = ?").run(userId).changes;
    const captainRequestsWithdrawn = world.db.prepare(
      "UPDATE goal_captain_requests SET status = 'declined', decidedBy = ?, decisionNote = ?, decidedAt = ? WHERE userId = ? AND status = 'pending'",
    ).run(userId, "Withdrawn: the asker reset their account.", nowIso(), userId).changes;
    const directGrantsRemoved = world.db.prepare("DELETE FROM direct_grants WHERE userId = ?").run(userId).changes;
    return { rolesRemoved, goalsReleased, accessRequestsDeleted, captainRequestsWithdrawn, directGrantsRemoved, agentsRetired: [] as string[] };
  });
  // their own visitor agents (never the human avatar), retired by the system: the user may not manage their home building
  for (const a of world.agents.where(`ownerUserId = ? AND kind = 'visitor' AND ${NOT_GONE}`, [userId], "ORDER BY createdAt, rowid")) {
    world.ops.dismissAgent(null, a.id);
    out.agentsRetired.push(a.id);
  }
  const who = user.githubLogin ? `@${user.githubLogin}` : user.name;
  world.events.append({ type: "system", text: `${who} reset their account to a visitor`, payload: { userId, ...out } });
  // pending rows may have left the Town Hall in-tray: resend the building with its count
  const th = world.buildings.first("kind = 'town-hall'");
  if (th) world.changes.emit({ type: "building", building: { ...th, intray: world.ops.intrayCount(th.id) } });
  return out;
}
