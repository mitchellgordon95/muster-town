import { AppError, canSeeDoc, findManual, revisionsOf, searchDocs, unpublishTownFyi, whereOf } from "@muster-town/core";
import { CreateMeetingInput, DocState, DocType, MeetingPhase, MeetingPresentInput, MeetingSayInput, ReplyInput, ReviewInput, VerbInputs } from "@muster-town/schema";
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
const PromoteBody = z.object({ state: z.enum(["building", "library"]) });
const RequestBody = z.object({ action: z.enum(["claim", "done", "delete"]), body: z.string().optional() });
const MeetingsQuery = z.object({ buildingId: z.string().optional(), phase: MeetingPhase.optional() });
const EndBody = z.object({ closing: z.string().optional() });

/** Library/board docs, reviews, outbox lifecycle; meetings. */
export async function docRoutes(app: FastifyInstance) {
  const world = app.world;

  app.get("/api/docs", async (req) => {
    const q = parse(DocsQuery, req.query);
    const viewer = viewerId(req);
    if (q.q?.trim()) {
      return { docs: searchDocs(world, viewer, { query: q.q, type: q.type, state: q.state, buildingId: q.buildingId, limit: q.limit }) };
    }
    const where = whereOf({ state: q.state, type: q.type, buildingId: q.buildingId }, [{ sql: "(state != 'draft' OR authorId = ?)", params: [viewer] }]);
    return { docs: world.docs.where(where.sql, where.params, `ORDER BY updatedAt DESC, rowid DESC LIMIT ${q.limit}`) };
  });

  /** The humans' operating manual (the Town Hall article tagged `manual`; the HUD "?" opens it). */
  app.get("/api/manual", async () => {
    const doc = findManual(world);
    if (!doc) throw new AppError("not_found", "no operating manual yet");
    return { doc, author: world.nameOf(doc.authorId) };
  });

  app.get<{ Params: Params }>("/api/docs/:id", async (req) => {
    const doc = world.docs.get(req.params.id);
    if (!doc || !canSeeDoc({ kind: "user", id: viewerId(req) }, doc)) throw new AppError("not_found", `doc not found: ${req.params.id}`);
    // topic pages: the bodies their rewrites replaced, oldest first (anyone who can read the page)
    return { doc, author: world.nameOf(doc.authorId), ...(doc.topicOf ? { revisions: revisionsOf(world, doc.id) } : {}) };
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
    const { text, deckSlide, meetingId } = parse(ReplyInput, req.body);
    const actor = actorOf(world, req);
    const r = world.ops.replyToReport(actor, req.params.id, text, { deckSlide });
    if (meetingId) world.ops.slideReplyDecision(actor, meetingId, req.params.id, text);
    return r;
  });

  app.post<{ Params: Params }>("/api/docs/:id/archive", async (req) => {
    const { deckSlide, meetingId } = parse(ReplyInput, req.body ?? {});
    const actor = actorOf(world, req);
    const r = world.ops.archiveReport(actor, req.params.id, { deckSlide });
    if (meetingId) world.ops.slideReplyDecision(actor, meetingId, req.params.id, "");
    return r;
  });

  /** Take a town-wide FYI off the Town Hall board (back to its author's drafts): its author or a town admin. */
  app.post<{ Params: Params }>("/api/docs/:id/unpublish", async (req) => ({ doc: unpublishTownFyi(world, actorOf(world, req), req.params.id) }));

  app.post<{ Params: Params }>("/api/docs/:id/promote", async (req) => {
    const { state } = parse(PromoteBody, req.body);
    const actor = actorOf(world, req);
    await world.verbs.promote(actor, { docId: req.params.id, state });
    return { doc: world.docs.require(req.params.id, "doc") };
  });

  app.post<{ Params: Params }>("/api/docs/:id/request", async (req) => {
    const { action, body } = parse(RequestBody, req.body);
    const r = world.ops.requestAction(actorOf(world, req), req.params.id, action, body);
    return { doc: r.request, deleted: r.request === null, humanReport: r.humanReport };
  });

  // ---- meetings ----
  app.get("/api/meetings", async (req) => {
    const q = parse(MeetingsQuery, req.query);
    const townHall = q.buildingId === "town-hall";
    const where = whereOf({ buildingId: townHall ? undefined : q.buildingId, phase: q.phase },
      [townHall && { sql: "(buildingId IS NULL OR buildingId = 'town-hall')", params: [] }]);
    return { meetings: world.meetings.where(where.sql, where.params, "ORDER BY scheduledAt DESC, rowid DESC LIMIT 100") };
  });

  app.post("/api/meetings", async (req, reply) => {
    const input = parse(CreateMeetingInput, req.body);
    const meeting = world.ops.createMeeting(actorOf(world, req), input);
    return reply.code(201).send({ meeting });
  });

  /**
   * A 1:1 (docs/waterfall.md §3.4): open it, or return the human's open one with that agent. Body (optional):
   * `agentId` (default the building's manager; a fork or gone author resolves to its manager) and `docId` (a report
   * the human's first line presents) or `grantId` (a grant presented the same way; without `agentId` it reaches its
   * proposer, else the building's manager).
   */
  app.post<{ Params: Params }>("/api/buildings/:id/one-on-one", async (req) => {
    requireAuth(req);
    const body = (req.body ?? {}) as { agentId?: unknown; docId?: unknown; grantId?: unknown };
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    return { meeting: world.ops.openOneOnOne(actorOf(world, req), req.params.id, { agentId: str(body.agentId), docId: str(body.docId), grantId: str(body.grantId) }) };
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
    const { text, attach } = parse(MeetingSayInput, req.body);
    return { meeting: world.ops.meetingSay(actorOf(world, req), req.params.id, text, attach) };
  });

  app.post<{ Params: Params }>("/api/meetings/:id/typing", async (req, reply) => {
    requireAuth(req);
    world.ops.meetingTyping(actorOf(world, req), req.params.id);
    return reply.code(204).send();
  });

  /** Presentation mode (gr_jh0lu0w6yj step 5): show a deck's slide above every attendee's chat; `docId` null stops. */
  app.post<{ Params: Params }>("/api/meetings/:id/present", async (req) => {
    requireAuth(req);
    const { docId, slide } = parse(MeetingPresentInput, req.body);
    return { meeting: world.ops.meetingPresent(actorOf(world, req), req.params.id, docId, slide) };
  });

  // agents writing a reply or decisions right now; the meeting panel polls this while the meeting is live
  app.get<{ Params: Params }>("/api/meetings/:id/drafting", async (req) => ({ drafting: world.ops.meetingDrafting(req.params.id) }));

  app.post<{ Params: Params }>("/api/meetings/:id/end", async (req) => {
    requireAuth(req);
    const { closing } = parse(EndBody, req.body);
    return { meeting: world.ops.endMeeting(actorOf(world, req), req.params.id, closing) };
  });
}
