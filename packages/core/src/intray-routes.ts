import type { Agent, CaptainRequestView, Doc, GrantView, IntrayRoute, IntrayRoutes } from "@muster-town/schema";
import { canDecideCaptain } from "./captain.ts";
import type { GoalProposalView } from "./goals.ts";
import { holderOf } from "./permissions.ts";
import type { World } from "./world.ts";

/**
 * The Town Hall in-tray's routing for one viewer (docs/goals.md "Captains on nodes", build step 4). Every item routes to
 * the owner of the goal it belongs to (`Goals.route`): grants by their key result's goal, goal proposals by their target
 * or parent, rollups by the building's attachment. "Mine" = routed to the viewer (an admin's when it ends at the town
 * admins, the root's owners). `canDecide`: grants by `Grants.canFund` (building.fund, or the goal's owner); goal
 * proposals by `goals.edit` at their node (a human only); captain requests to the goal asked about, decided by `goals.edit`
 * there (its current captain, a captain above, or an admin; captain.ts); reports by `building.review` on the Town Hall, as today.
 * Anonymous viewers get routes with nothing theirs and nothing decidable.
 */
export function intrayRoutes(world: World, viewer: Agent | undefined, items: { grants: GrantView[]; goalProposals: GoalProposalView[]; reports: Doc[]; captains?: CaptainRequestView[] }): IntrayRoutes {
  const human = viewer?.kind === "human" ? viewer : undefined;
  const user = human ? holderOf(human) : null;
  const userId = user?.kind === "user" ? user.id : null;
  const admin = !!human && world.permissions.isAdmin(human);
  const th = world.buildings.first("kind = 'town-hall'");
  const routes: Record<string, IntrayRoute> = {};
  const add = (id: string, item: Parameters<World["goalTree"]["route"]>[0], canDecide: boolean) => {
    const r = world.goalTree.route(item);
    routes[id] = {
      goalId: r.goalId, ownerId: r.userId, ownerName: r.userId ? world.users.get(r.userId)?.name ?? r.userId : "the town admins",
      mine: !!userId && (r.userId ? r.userId === userId : admin), canDecide,
    };
  };
  for (const g of items.grants) add(g.id, { grantId: g.id }, !!human && world.grantDesk.canFund(human, g));
  for (const p of items.goalProposals) {
    const node = world.goalTree.nodeOfProposal(p);
    add(p.id, { proposalId: p.id }, !!human && (!node || world.goalTree.canEdit(human, node)));
  }
  for (const c of items.captains ?? []) add(c.id, { goalId: c.goalId }, canDecideCaptain(world, human, c.goalId));
  for (const d of items.reports) add(d.id, { buildingId: d.buildingId ?? undefined }, !!human && !!th && world.permissions.can(human, "building.review", th.id));
  // an owner who is not an admin starts on Mine; everyone else on All
  const ownsNode = !!userId && world.goals.count("ownerId = ? AND status = 'active'", [userId]) > 0;
  return { routes, defaultView: ownsNode && !admin ? "mine" : "all" };
}

