import { CaptainDecisionInput, CaptainRequestInput, ChangeGoalInput, CreateGoalInput, ReviewKeyResultInput, DecideGoalProposalInput, GoalProposalStatus, ProposeGoalInput, RetireGoalInput, UpdateGoalInput } from "@muster-town/schema";
import { buildingBoard, decideCaptain, goalBoard, goalFunding, pendingCaptainRequests, requestCaptain, worldGoalSpend } from "@muster-town/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorOf, funderOf, parse, requireUser, type Params } from "../context.ts";

const TreeQuery = z.object({ retired: z.enum(["0", "1"]).optional() });
const ProposalsQuery = z.object({ status: GoalProposalStatus.optional(), buildingId: z.string().optional() });
const SpendQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(7), funder: z.string().min(1).optional() });
const AttachInput = z.object({ goalId: z.string().min(1) });
const ChangesQuery = z.object({ goalId: z.string().optional(), open: z.enum(["0", "1"]).optional() });
const PlanInput = z.object({ goalId: z.string().min(1).optional() });

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
      owner: { ...owner, name: world.users.get(owner.userId)?.name ?? owner.userId },
      children: tree.children(goal.id), keyResults: world.keyResults.where("goalId = ?", [goal.id], "ORDER BY position, rowid"),
      buildings: world.buildings.where("goalId = ?", [goal.id], "ORDER BY createdAt, rowid").map((b) => ({ id: b.id, name: b.name })),
      funding: goalFunding(world, goal.id),
    };
  });

  /** The goal's history, newest first (for agents: the Planner's digest and the API; not shown in the web, 1:1 mt_n25udpflus decision 5): goal, key result, attachment and proposal events. */
  app.get<{ Params: Params }>("/api/goals/:id/history", async (req) => ({ events: tree.history(req.params.id) }));

  /** The Bank's "Spend by goal": the goal's subtree spend from session rows, by lane, building, key result and day or week (read-only; no Bank read or write). */
  // `?funder=me` (or a user id; signed in): only what that funder's money paid for (the funder filter, build step 8)
  app.get<{ Params: Params }>("/api/goals/:id/spend", async (req) => {
    const q = parse(SpendQuery, req.query);
    return worldGoalSpend(world, req.params.id, q.days, new Date(), q.funder ? funderOf(req, q.funder) : null);
  });

  /** The goal's queue (build step 6, API only since decision 5 of mt_n25udpflus: the web shows queues per building): the kanban of every building attached in its subtree, one swimlane each (read-only). */
  app.get<{ Params: Params }>("/api/goals/:id/queue", async (req) => goalBoard(world, req.params.id));

  /** The building's Queue tab: its kanban, Queued / Held / Running / Done, WIP = its desks (read-only). */
  app.get<{ Params: Params }>("/api/buildings/:id/queue", async (req) => buildingBoard(world, req.params.id));

  app.post("/api/goals", async (req, reply) => reply.code(201).send({ goal: tree.create(actorOf(world, req), parse(CreateGoalInput, req.body)) }));

  app.patch<{ Params: Params }>("/api/goals/:id", async (req) => ({ goal: tree.update(actorOf(world, req), req.params.id, parse(UpdateGoalInput, req.body)) }));

  // "Ask to captain this goal" (gr_bwm0iz7rwl): a member asks; the goal's current captain (or an admin) decides. The
  // pending requests are also Town Hall in-tray items (`captains` on GET /api/buildings/town-hall/intray, routed there).
  app.post<{ Params: Params }>("/api/goals/:id/captain-requests", async (req, reply) => {
    const user = requireUser(req);
    const input = parse(CaptainRequestInput, req.body ?? {});
    return reply.code(201).send({ captainRequest: requestCaptain(world, user.id, req.params.id, input.note ?? "") });
  });
  app.get<{ Params: Params }>("/api/goals/:id/captain-requests", async (req) => {
    tree.require(req.params.id);
    return { captainRequests: pendingCaptainRequests(world).filter((r) => r.goalId === req.params.id) };
  });
  app.post<{ Params: Params }>("/api/captain-requests/:id/decide", async (req) => {
    const input = parse(CaptainDecisionInput, req.body);
    return { captainRequest: decideCaptain(world, actorOf(world, req), req.params.id, input.action === "accept", input.note ?? "") };
  });

  app.post<{ Params: Params }>("/api/goals/:id/retire", async (req) => ({ goal: tree.retire(actorOf(world, req), req.params.id, parse(RetireGoalInput, req.body)) }));

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

  /** "Change this goal" (the reorg, build step 5): X → Y, prep assignments, under-review key results and a planning meeting. */
  app.post<{ Params: Params }>("/api/goals/:id/change", async (req, reply) => reply.code(201).send({ change: world.reorgs.file(actorOf(world, req), req.params.id, parse(ChangeGoalInput, req.body)) }));

  app.get("/api/goal-changes", async (req) => { const q = parse(ChangesQuery, req.query); return { changes: world.reorgs.list({ goalId: q.goalId, open: q.open === "1" }) }; });

  /** An under-review key result: keep, move (goalId) or archive as missed (a human with goals.edit there). */
  app.post<{ Params: Params }>("/api/key-results/:id/review", async (req) => ({ keyResult: world.reorgs.reviewKr(actorOf(world, req), req.params.id, parse(ReviewKeyResultInput, req.body)) }));

  /** "Plan with an agent": open (or return to) the human's 1:1 with the Planner, about a goal when `goalId` is given. */
  app.post("/api/planner/one-on-one", async (req) => ({ meeting: world.reorgs.openPlanner(actorOf(world, req), parse(PlanInput, req.body ?? {}).goalId) }));

  app.get("/api/goal-proposals", async (req) => ({ proposals: tree.listProposals(parse(ProposalsQuery, req.query)) }));

  app.post("/api/goal-proposals", async (req, reply) => reply.code(201).send({ proposal: tree.propose(actorOf(world, req), parse(ProposeGoalInput, req.body)) }));

  app.post<{ Params: Params }>("/api/goal-proposals/:id/decide", async (req) => ({ proposal: tree.decideProposal(actorOf(world, req), req.params.id, parse(DecideGoalProposalInput, req.body)) }));
}
