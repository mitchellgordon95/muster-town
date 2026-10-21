import { AppError, canSeeDoc } from "@muster-town/core";
import { PinSkillInput } from "@muster-town/schema";
import type { FastifyInstance } from "fastify";
import { actorOf, parse, viewerId, type Params } from "../context.ts";

/**
 * Skills (docs/skills.md). Writing one is the `write` verb (POST /api/docs or /api/verbs/write with type "skill" and
 * optional `files`); these routes list skills, serve their files (a desk can unpack the bundle) and manage pins.
 */
export async function skillRoutes(app: FastifyInstance) {
  const world = app.world;
  const skills = world.skills;
  /** The skill doc if the caller may see it (drafts only to their author). */
  const visible = (req: Parameters<typeof viewerId>[0], id: string) => {
    const doc = world.docs.get(id);
    const viewer = viewerId(req);
    if (!doc || doc.type !== "skill" || !(canSeeDoc({ kind: "user", id: viewer }, doc) || doc.authorId === viewer)) throw new AppError("not_found", `skill not found: ${id}`);
    return doc;
  };

  app.get("/api/skills", async (req) => {
    const viewer = viewerId(req);
    return { skills: skills.listAll(viewer ? { kind: req.auth?.kind === "agent" ? "agent" : "user", id: viewer } : null) };
  });

  app.get<{ Params: Params }>("/api/skills/:id", async (req) => {
    const doc = visible(req, req.params.id);
    return { skill: skills.view(doc), body: doc.body };
  });

  /** Every file with its content, plus SKILL.md: what a desk writes to ~/skills/<name>/. */
  app.get<{ Params: Params }>("/api/skills/:id/bundle", async (req) => {
    const doc = visible(req, req.params.id);
    return { id: doc.id, name: doc.title, files: [{ path: "SKILL.md", content: doc.body }, ...skills.bundle(doc.id)] };
  });

  app.get<{ Params: Params & { "*": string } }>("/api/skills/:id/files/*", async (req, reply) => {
    const doc = visible(req, req.params.id);
    const path = req.params["*"];
    const content = path === "SKILL.md" ? doc.body : skills.file(doc.id, path);
    return reply.type("text/plain; charset=utf-8").send(content);
  });

  app.post<{ Params: Params }>("/api/skills/:id/pins", async (req, reply) => {
    const pin = skills.pin(actorOf(world, req), req.params.id, parse(PinSkillInput, req.body));
    return reply.code(201).send({ pin });
  });

  app.delete<{ Params: Params }>("/api/skill-pins/:id", async (req) => {
    const pin = world.skillPins.require(req.params.id, "skill pin");
    return skills.removePin(actorOf(world, req), pin);
  });
}
