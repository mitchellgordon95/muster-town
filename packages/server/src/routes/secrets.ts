import { AppError } from "@muster-town/core";
import { PutSecretInput } from "@muster-town/schema";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { parse, requireUser } from "../context.ts";

/**
 * Collective secrets (docs/secrets.md), managed at the Town Hall by the collective's admins: humans only (a user
 * token or session), never an agent token, so no resident can grant itself a credential. Values are write-only:
 * every response lists names, grants and set/missing, never a value.
 */
export async function secretRoutes(app: FastifyInstance) {
  const world = app.world;
  const admin = (req: FastifyRequest) => {
    const user = requireUser(req);
    if (!world.permissions.isAdmin({ kind: "user", id: user.id })) throw new AppError("forbidden", "Only a collective admin can manage secrets.", 403);
    return user;
  };

  app.get("/api/secrets", async (req) => {
    admin(req);
    return { secrets: world.secrets.list(), keyConfigured: world.secrets.keyConfigured() };
  });

  /** Create, or replace the value and/or the grants. Without a host data key, a value is refused (409), never stored in plaintext. */
  app.put<{ Params: { name: string } }>("/api/secrets/:name", async (req) => {
    const user = admin(req);
    return { secret: world.secrets.put(req.params.name, parse(PutSecretInput, req.body), user.id) };
  });

  app.delete<{ Params: { name: string } }>("/api/secrets/:name", async (req) => {
    const user = admin(req);
    return world.secrets.delete(req.params.name, user.id);
  });
}
