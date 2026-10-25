import { AppError } from "@muster-town/core";
import { CloseGrantInput, CreateGrantInput, CreateKeyResultInput, DecideGrantInput, GrantsQuery, UpdateGrantInput, UpdateKeyResultInput } from "@muster-town/schema";
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

  app.post<{ Params: Params }>("/api/grants/:id/decide", async (req) => ({
    grant: desk.decide(actorOf(world, req), req.params.id, parse(DecideGrantInput, req.body)),
  }));

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
}
