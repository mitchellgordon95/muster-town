import { jobThread } from "@muster-town/core";
import type { FastifyInstance } from "fastify";
import type { Params } from "../context.ts";

/**
 * The job abstraction, step 1 (plan dc_uwx045472m, grant gr_9mp6v6vv8k): read only. GET /api/jobs/:id returns a job
 * (by its id, or by its pocketRef: a grant, a schedule, a building id, a human source) and its thread of entries,
 * back-filled by core jobs.ts. Public like the grants and reports it is read from; a draft grant's job is not found.
 */
export async function jobRoutes(app: FastifyInstance) {
  const world = app.world;
  app.get<{ Params: Params }>("/api/jobs/:id", async (req) => jobThread(world, req.params.id));
}
