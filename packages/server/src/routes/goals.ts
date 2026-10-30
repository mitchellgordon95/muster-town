import { CreateGoalInput, CreateTreeKeyResultInput, DecideGoalProposalInput, GoalProposalStatus, ProposeGoalInput, RetireGoalInput, UpdateGoalInput } from "@muster-town/schema";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorOf, parse, type Params } from "../context.ts";

const TreeQuery = z.object({ retired: z.enum(["0", "1"]).optional() });
const ProposalsQuery = z.object({ status: GoalProposalStatus.optional(), buildingId: z.string().optional() });
const AttachInput = z.object({ goalId: z.string().min(1) });

/**
 * The town goal tree (docs/goals.md, build step 1). Reads are public: the tree is the town's answer to "what is this
 * place trying to do". Edits take `goals.edit` (admins anywhere, an owner within their subtree); managers propose.
 */
export async function goalRoutes(app: FastifyInstance) {
  const world = app.world;
  const tree = world.goalTree;

  app.get("/api/goals", async (req) => ({ root: tree.tree({ retired: parse(TreeQuery, req.query).retired === "1" }) }));

  app.get<{ Params: Params }>("/api/goals/:id", async (req) => {
    const goal = tree.require(req.params.id);
    const owner = tree.ownerOf(goal.id);
    return {
      goal, path: tree.ancestors(goal.id).reverse().map((g) => ({ id: g.id, text: g.text })),
      owner: { ...owner, name: owner.userId ? world.users.get(owner.userId)?.name ?? owner.userId : "the town admins" },
      children: tree.children(goal.id), keyResults: world.keyResults.where("goalId = ?", [goal.id], "ORDER BY position, rowid"),
      buildings: world.buildings.where("goalId = ?", [goal.id], "ORDER BY createdAt, rowid").map((b) => ({ id: b.id, name: b.name })),
    };
  });

  app.post("/api/goals", async (req, reply) => reply.code(201).send({ goal: tree.create(actorOf(world, req), parse(CreateGoalInput, req.body)) }));

  app.patch<{ Params: Params }>("/api/goals/:id", async (req) => ({ goal: tree.update(actorOf(world, req), req.params.id, parse(UpdateGoalInput, req.body)) }));

  app.post<{ Params: Params }>("/api/goals/:id/retire", async (req) => ({ goal: tree.retire(actorOf(world, req), req.params.id, parse(RetireGoalInput, req.body)) }));

  app.post<{ Params: Params }>("/api/goals/:id/key-results", async (req, reply) =>
    reply.code(201).send({ keyResult: tree.addKeyResult(actorOf(world, req), req.params.id, parse(CreateTreeKeyResultInput, req.body)) }));

  /** The building's one attachment (also PATCH /api/buildings/:id with goalId). */
  app.put<{ Params: Params }>("/api/buildings/:id/goal", async (req) => ({ building: tree.attach(actorOf(world, req), req.params.id, parse(AttachInput, req.body).goalId) }));

  /** The building's subtree: its attachment's path and the open key results it may work toward (Goals.inScope). */
  app.get<{ Params: Params }>("/api/buildings/:id/scope", async (req) => {
    const b = world.buildings.require(req.params.id, "building");
    const goalId = tree.attachmentOf(b);
    return {
      goalId, path: tree.ancestors(goalId).reverse().map((g) => ({ id: g.id, text: g.text })), owner: tree.ownerOf(goalId),
      keyResults: tree.keyResultsInScope(b.id).filter((k) => tree.inScope(b.id, k.id)),
    };
  });

  app.get("/api/goal-proposals", async (req) => ({ proposals: tree.listProposals(parse(ProposalsQuery, req.query)) }));

  app.post("/api/goal-proposals", async (req, reply) => reply.code(201).send({ proposal: tree.propose(actorOf(world, req), parse(ProposeGoalInput, req.body)) }));

  app.post<{ Params: Params }>("/api/goal-proposals/:id/decide", async (req) => ({ proposal: tree.decideProposal(actorOf(world, req), req.params.id, parse(DecideGoalProposalInput, req.body)) }));
}
