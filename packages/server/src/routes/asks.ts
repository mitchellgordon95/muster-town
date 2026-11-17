import { AppError, claimsStale, decideAsk, deferAsk, markSeen, openAsks, runClaimChecks } from "@muster-town/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorOf, parse, type Params } from "../context.ts";

const DecideBody = z.object({ decision: z.string().trim().min(1).max(2000), note: z.string().trim().max(2000).optional() });
const DeferBody = z.object({ until: z.string().trim().min(1).max(400) });

/**
 * Asks (docs/legible-delegation.md §4-5, build steps 3-4): the open asks for the Town Hall, one ask (recording that a
 * signed-in human opened it, and re-running its claim checks when their results are older than 5 minutes), and a
 * human's decide and defer (core asks.ts: only a human who can fund the ask's building). Reads are public, like the
 * in-tray.
 */
export async function askRoutes(app: FastifyInstance) {
  const world = app.world;

  app.get("/api/asks", async () => ({ asks: openAsks(world) }));

  app.get<{ Params: Params }>("/api/asks/:id", async (req) => {
    let ask = world.asks.get(req.params.id);
    if (!ask) throw new AppError("not_found", `ask not found: ${req.params.id}`);
    if (req.auth?.kind === "user") markSeen(world, req.auth.user.id, "ask", ask.id);
    // a claim's check result is never older than 5 minutes when shown (docs/invariants/asks.md)
    if (claimsStale(world, ask)) ask = await runClaimChecks(world, ask);
    return { ask };
  });

  app.post<{ Params: Params }>("/api/asks/:id/decide", async (req) => {
    const body = parse(DecideBody, req.body);
    const actor = actorOf(world, req);
    // a branch whose action is "redeploy" does what it says (operating manual: an ask does the small tasks itself). Until
    // 2026-11-17 it only recorded its label, so Mitchell's "Press redeploy" on ak_nugzl9rheu started nothing (dc_4yrb3979ty).
    // Checked before deciding: a decider who cannot redeploy, or a server with no runtime, is refused and the ask stays open.
    const ask = world.asks.get(req.params.id);
    const branch = ask?.branches.find((b) => b.label.trim().toLowerCase() === body.decision.toLowerCase());
    const redeploy = branch?.action?.trim().toLowerCase() === "redeploy" && !ask?.targetKind;
    if (redeploy) {
      world.permissions.require(actor, "town.redeploy");
      if (!app.runtime?.redeploy) throw new AppError("internal", "This server has no runtime to redeploy: the ask stays open.", 503);
    }
    const decided = decideAsk(world, actor, req.params.id, body.decision, body.note);
    if (!redeploy) return { ask: decided };
    return { ask: decided, redeploy: await app.runtime!.redeploy!({ image: false, requestedBy: actor.name }) };
  });

  app.post<{ Params: Params }>("/api/asks/:id/defer", async (req) => ({
    ask: deferAsk(world, actorOf(world, req), req.params.id, parse(DeferBody, req.body).until),
  }));
}
