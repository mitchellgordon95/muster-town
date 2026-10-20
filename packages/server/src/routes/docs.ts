import { AppError, canSeeDoc, searchDocs } from "@muster-town/core";
import { AskInput, CreateMeetingInput, DocState, DocType, MeetingPhase, MeetingSayInput, ReplyInput, ReviewInput, VerbInputs } from "@muster-town/schema";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorOf, parse, requireAuth, viewerId, type Params } from "../context.ts";

const DocsQuery = z.object({
  state: DocState.optional(),
  type: DocType.optional(),
  buildingId: z.string().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});
const PromoteBody = z.object({ state: z.enum(["building", "library", "trophy"]) });
const TrophyBody = z.object({ approve: z.boolean() });
const RequestBody = z.object({ action: z.enum(["approve", "reject", "claim", "done"]), body: z.string().optional() });
const MeetingsQuery = z.object({ buildingId: z.string().optional(), phase: MeetingPhase.optional() });
const EndBody = z.object({ closing: z.string().optional() });

/** Library/board docs, reviews, outbox lifecycle, trophies; meetings. */
export async function docRoutes(app: FastifyInstance) {
  const world = app.world;

  app.get("/api/docs", async (req) => {
    const q = parse(DocsQuery, req.query);
    const viewer = viewerId(req);
    if (q.q?.trim()) {
      return { docs: searchDocs(world, viewer, { query: q.q, type: q.type, state: q.state, buildingId: q.buildingId, limit: q.limit }) };
    }
    const where = ["(state != 'draft' OR authorId = ?)"];
    const params: unknown[] = [viewer];
    if (q.state) { where.push("state = ?"); params.push(q.state); }
    if (q.type) { where.push("type = ?"); params.push(q.type); }
    if (q.buildingId) { where.push("buildingId = ?"); params.push(q.buildingId); }
    return { docs: world.docs.where(where.join(" AND "), params, `ORDER BY updatedAt DESC, rowid DESC LIMIT ${q.limit}`) };
  });

  app.get<{ Params: Params }>("/api/docs/:id", async (req) => {
    const doc = world.docs.get(req.params.id);
    if (!doc || !canSeeDoc({ kind: "user", id: viewerId(req) }, doc)) throw new AppError("not_found", `doc not found: ${req.params.id}`);
    return { doc, author: world.nameOf(doc.authorId) };
  });

  app.post("/api/docs", async (req, reply) => {
    const input = parse(VerbInputs.write, req.body);
    const r = await world.verbs.write(actorOf(world, req), input);
    return reply.code(input.id ? 200 : 201).send({ doc: world.docs.require(r.id, "doc") });
  });

  app.post<{ Params: Params }>("/api/docs/:id/review", async (req) => {
    const input = parse(ReviewInput, req.body);
    const r = await world.verbs.review(actorOf(world, req), { docId: req.params.id, ...input });
    return {
      doc: world.docs.require(req.params.id, "doc"),
      assignment: r.assignmentId ? world.assignments.get(r.assignmentId) ?? null : null,
    };
  });

  /** Reports as replies: one text box, one button. → { doc, assignment | null }. Empty text = archive. */
  app.post<{ Params: Params }>("/api/docs/:id/reply", async (req) => {
    const { text } = parse(ReplyInput, req.body);
    return world.ops.replyToReport(actorOf(world, req), req.params.id, text);
  });

  app.post<{ Params: Params }>("/api/docs/:id/archive", async (req) => world.ops.archiveReport(actorOf(world, req), req.params.id));

  /** Ask about a report without bothering its author (cheap-model proxy). → { reply } */
  app.post<{ Params: Params }>("/api/docs/:id/ask", async (req) => {
    requireAuth(req);
    const { question, history } = parse(AskInput, req.body);
    const doc = world.docs.get(req.params.id);
    if (!doc || !canSeeDoc({ kind: "user", id: viewerId(req) }, doc)) throw new AppError("not_found", `doc not found: ${req.params.id}`);
    if (!app.runtime?.askAbout) throw new AppError("internal", "runtime not available", 503);
    const r = await app.runtime.askAbout(doc.id, question, viewerId(req), history);
    return { reply: typeof r === "string" ? r : r.reply };
  });

  app.post<{ Params: Params }>("/api/docs/:id/promote", async (req) => {
    const { state } = parse(PromoteBody, req.body);
    const actor = actorOf(world, req);
    if (state === "trophy") return { doc: world.ops.decideTrophy(actor, req.params.id, true) };
    await world.verbs.promote(actor, { docId: req.params.id, state });
    return { doc: world.docs.require(req.params.id, "doc") };
  });

  app.post<{ Params: Params }>("/api/docs/:id/trophy", async (req) => {
    const { approve } = parse(TrophyBody, req.body);
    return { doc: world.ops.decideTrophy(actorOf(world, req), req.params.id, approve) };
  });

  app.post<{ Params: Params }>("/api/docs/:id/request", async (req) => {
    const { action, body } = parse(RequestBody, req.body);
    const r = world.ops.requestAction(actorOf(world, req), req.params.id, action, body);
    return { doc: r.request, humanReport: r.humanReport };
  });

  // ---- meetings ----
  app.get("/api/meetings", async (req) => {
    const q = parse(MeetingsQuery, req.query);
    const where: string[] = ["1=1"];
    const params: unknown[] = [];
    if (q.buildingId) {
      if (q.buildingId === "town-hall") where.push("(buildingId IS NULL OR buildingId = 'town-hall')");
      else { where.push("buildingId = ?"); params.push(q.buildingId); }
    }
    if (q.phase) { where.push("phase = ?"); params.push(q.phase); }
    return { meetings: world.meetings.where(where.join(" AND "), params, "ORDER BY scheduledAt DESC, rowid DESC LIMIT 100") };
  });

  app.post("/api/meetings", async (req, reply) => {
    const input = parse(CreateMeetingInput, req.body);
    const meeting = world.ops.createMeeting(actorOf(world, req), input);
    return reply.code(201).send({ meeting });
  });

  app.get<{ Params: Params }>("/api/meetings/:id", async (req) => ({ meeting: world.meetings.require(req.params.id, "meeting") }));

  app.post<{ Params: Params }>("/api/meetings/:id/start", async (req) => {
    const meeting = world.ops.startMeeting(actorOf(world, req), req.params.id);
    if (app.runtime?.onMeetingStart) {
      Promise.resolve(app.runtime.onMeetingStart(meeting.id)).catch((e) => app.log.error({ err: e }, "[server] runtime.onMeetingStart failed"));
    }
    return { meeting };
  });

  app.post<{ Params: Params }>("/api/meetings/:id/say", async (req) => {
    const { text } = parse(MeetingSayInput, req.body);
    return { meeting: world.ops.meetingSay(actorOf(world, req), req.params.id, text) };
  });

  app.post<{ Params: Params }>("/api/meetings/:id/end", async (req) => {
    requireAuth(req);
    const { closing } = parse(EndBody, req.body);
    return { meeting: world.ops.endMeeting(actorOf(world, req), req.params.id, closing) };
  });
}
