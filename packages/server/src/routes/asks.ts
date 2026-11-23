import { actOf, actOnAsk, AppError, claimsStale, deferAsk, markSeen, openAsks, runClaimChecks } from "@muster-town/core";
import { DecideAskInput } from "@muster-town/schema";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorOf, parse, type Params } from "../context.ts";

const DeferBody = z.object({ until: z.string().trim().min(1).max(400) });

/**
 * Asks (docs/legible-delegation.md §4-5, build steps 3-4): the open asks for the Town Hall, one ask (recording that a
 * signed-in human opened it, and re-running its claim checks when their results are older than 5 minutes), and a
 * human's decide (core ask-acts.ts: the pressed branch's act, done on its target) and defer (core asks.ts: only a
 * human who can decide the ask). Reads are public, like the
 * in-tray.
 */
export async function askRoutes(app: FastifyInstance) {
  const world = app.world;

  app.get("/api/asks", async () => ({ asks: openAsks(world) }));

  // `?peek=1`: a link labelling the id by its title (gr_4upa0og9zc step 2) reads it without marking it seen or re-running checks
  app.get<{ Params: Params; Querystring: { peek?: string } }>("/api/asks/:id", async (req) => {
    let ask = world.asks.get(req.params.id);
    if (!ask) throw new AppError("not_found", `ask not found: ${req.params.id}`);
    if (req.query.peek === "1") return { ask };
    if (req.auth?.kind === "user") markSeen(world, req.auth.user.id, "ask", ask.id);
    // a claim's check result is never older than 5 minutes when shown (docs/invariants/asks.md)
    if (claimsStale(world, ask)) ask = await runClaimChecks(world, ask);
    return { ask };
  });

  // a human presses a branch: the server does its act on the target (core ask-acts.ts; 1:1 mt_m6qjva55rh), the card only
  // draws it. A branch whose act is "redeploy" redeploys (operating manual: an ask does the small tasks itself; until
  // 2026-11-17 it only recorded its label, dc_4yrb3979ty): checked before deciding, so a decider who cannot redeploy,
  // or a server with no runtime, is refused and the ask stays open.
  app.post<{ Params: Params }>("/api/asks/:id/decide", async (req) => {
    const body = parse(DecideAskInput, req.body);
    const actor = actorOf(world, req);
    const ask = world.asks.get(req.params.id);
    const redeploy = !!ask && actOf(world, ask, body.decision).kind === "redeploy";
    if (redeploy) {
      world.permissions.require(actor, "town.redeploy");
      if (!app.runtime?.redeploy) throw new AppError("internal", "This server has no runtime to redeploy: the ask stays open.", 503);
    }
    const { ask: decided, act } = actOnAsk(world, actor, req.params.id, body);
    if (!redeploy) return { ask: decided, act: act.kind };
    return { ask: decided, act: act.kind, redeploy: await app.runtime!.redeploy!({ image: false, requestedBy: actor.name }) };
  });

  app.post<{ Params: Params }>("/api/asks/:id/defer", async (req) => ({
    ask: deferAsk(world, actorOf(world, req), req.params.id, parse(DeferBody, req.body).until),
  }));
}
