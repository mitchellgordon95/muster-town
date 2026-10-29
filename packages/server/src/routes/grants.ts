import { AppError, townKpis } from "@muster-town/core";
import { CloseGrantInput, CreateGrantInput, CreateKeyResultInput, CreateObjectiveInput, DecideGrantInput, GrantsQuery, UpdateGrantInput, UpdateKeyResultInput, UpdateObjectiveInput } from "@muster-town/schema";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorOf, parse, type Params } from "../context.ts";

const ProposeInput = z.object({ note: z.string().max(2000).default("") });

/**
 * Goal-directed budgets (design dc_k955hun6c4): a building's goal key results (humans write them), its proposals and
 * grants (each names one key result), decisions, closing.
 * Reads are public except drafts, which only the building's managers and funders see. The budget part of
 * GET /api/buildings/:id/board lives in town.ts.
 */
export async function grantRoutes(app: FastifyInstance) {
  const world = app.world;
  const desk = world.grantDesk;

  app.get<{ Params: Params }>("/api/buildings/:id/grants", async (req) => {
    const { status } = parse(GrantsQuery, req.query);
    const includeDrafts = !!req.auth && desk.canManage(actorOf(world, req), req.params.id);
    return { grants: desk.list(req.params.id, { status, includeDrafts }) };
  });

  app.get<{ Params: Params }>("/api/grants/:id", async (req) => {
    const grant = desk.get(req.params.id);
    if (grant.status === "draft" && !(req.auth && desk.canManage(actorOf(world, req), grant.buildingId))) {
      throw new AppError("not_found", "grant not found");
    }
    return { grant };
  });

  app.post<{ Params: Params }>("/api/buildings/:id/grants", async (req, reply) => {
    const grant = desk.create(actorOf(world, req), req.params.id, parse(CreateGrantInput, req.body));
    return reply.code(201).send({ grant });
  });

  app.patch<{ Params: Params }>("/api/grants/:id", async (req) => ({
    grant: desk.update(actorOf(world, req), req.params.id, parse(UpdateGrantInput, req.body)),
  }));

  app.post<{ Params: Params }>("/api/grants/:id/propose", async (req) => ({
    grant: desk.propose(actorOf(world, req), req.params.id, parse(ProposeInput, req.body ?? {}).note),
  }));

  app.post<{ Params: Params }>("/api/grants/:id/decide", async (req) => {
    const input = parse(DecideGrantInput, req.body);
    const actor = actorOf(world, req);
    const grant = desk.decide(actor, req.params.id, input);
    // decided on a slide presented in a live meeting: one of its decisions too
    if (input.meetingId) world.ops.slideGrantDecision(actor, input.meetingId, req.params.id, input.action);
    return { grant };
  });

  app.post<{ Params: Params }>("/api/grants/:id/close", async (req) => ({
    grant: desk.close(actorOf(world, req), req.params.id, parse(CloseGrantInput, req.body)),
  }));

  app.get<{ Params: Params }>("/api/buildings/:id/key-results", async (req) => {
    world.buildings.require(req.params.id, "building");
    return { keyResults: desk.keyResults(req.params.id), blocked: desk.blocked(req.params.id) };
  });

  app.post<{ Params: Params }>("/api/buildings/:id/key-results", async (req, reply) => {
    const keyResult = desk.createKeyResult(actorOf(world, req), req.params.id, parse(CreateKeyResultInput, req.body));
    return reply.code(201).send({ keyResult });
  });

  app.delete<{ Params: Params }>("/api/key-results/:id", async (req) => {
    desk.deleteKeyResult(actorOf(world, req), req.params.id);
    return { ok: true };
  });

  app.patch<{ Params: Params }>("/api/key-results/:id", async (req) => ({
    keyResult: desk.updateKeyResult(actorOf(world, req), req.params.id, parse(UpdateKeyResultInput, req.body)),
  }));

  // Objectives and KPIs (docs/goal-directed-budgets.md): objectives hold the goal's key results; KPIs are the town's
  // standing indicators, computed live.
  app.get<{ Params: Params }>("/api/buildings/:id/objectives", async (req) => {
    world.buildings.require(req.params.id, "building");
    return desk.objectiveTree(req.params.id);
  });

  app.post<{ Params: Params }>("/api/buildings/:id/objectives", async (req, reply) => {
    const objective = desk.createObjective(actorOf(world, req), req.params.id, parse(CreateObjectiveInput, req.body));
    return reply.code(201).send({ objective });
  });

  app.patch<{ Params: Params }>("/api/objectives/:id", async (req) => ({
    objective: desk.updateObjective(actorOf(world, req), req.params.id, parse(UpdateObjectiveInput, req.body)),
  }));

  app.delete<{ Params: Params }>("/api/objectives/:id", async (req) => {
    desk.deleteObjective(actorOf(world, req), req.params.id);
    return { ok: true };
  });

  app.get("/api/kpis", async () => {
    const { framing, kpis } = townKpis(world);
    const objectives = world.buildings.all().filter((b) => b.kind !== "town-hall")
      .map((b) => ({ buildingId: b.id, name: b.name, goal: b.goal, ...desk.objectiveTree(b.id) }));
    return { framing, kpis, buildings: objectives };
  });
}
