import { canInteract, isAppError } from "@muster-town/core";
import { ClientMessage, type ServerMessage } from "@muster-town/schema";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { ASK_FIRST, resolveToken } from "./context.ts";
import { WS_NORMAL_CLOSE } from "./monitor.ts";

/** Drop a client that falls this far behind instead of buffering without bound. */
const MAX_BUFFERED = 8 * 1024 * 1024;

/**
 * WS `/ws`: on connect, a snapshot and live `world.changes`. A handshake carrying a user (session cookie or bearer
 * header) is signed in at once (snapshot has `avatarAgentId`); otherwise the socket is a read-only guest until an
 * `auth` message (→ a fresh snapshot with `avatarAgentId`). Client messages: `human.move` (validated walkability),
 * `human.say` (the `say` verb as the avatar); guests, and signed-in visitors without `town.interact`, get an `error` frame for both.
 */
export async function wsRoutes(app: FastifyInstance) {
  const world = app.world;

  /** the same frame to one socket, skipping a closed one and dropping one that has fallen too far behind */
  const sendRaw = (socket: WebSocket, data: string) => {
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED) { socket.close(1013, "too slow"); return; }
    socket.send(data);
  };
  // One subscription for the whole server: a change is stringified once and the one string goes to every streaming socket.
  // (One subscription per socket cost a JSON.stringify per viewer per change: about 0.06 ms of loop time each, docs/scaling.md row 2.)
  const streaming = new Set<WebSocket>();
  world.changes.subscribe((msg) => {
    if (streaming.size === 0) return;
    const data = JSON.stringify(msg);
    for (const socket of streaming) sendRaw(socket, data);
  });

  app.get("/ws", { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    let avatarId: string | null = null;
    app.load.clientOpened();
    let counted = true;
    const gone = () => { streaming.delete(socket); if (counted) { counted = false; app.load.clientClosed(); } };

    /** a frame for this socket alone (the snapshot and error frames differ per socket) */
    const send = (msg: ServerMessage | (ServerMessage & Record<string, unknown>)) => sendRaw(socket, JSON.stringify(msg));
    const fail = (message: string) => send({ type: "error", message });
    /** snapshot first, then stream; join the shared subscription synchronously after so nothing falls in between */
    const stream = () => {
      send(avatarId ? { ...world.snapshot(), avatarAgentId: avatarId } : world.snapshot());
      streaming.add(socket);
    };
    if (req.auth?.kind === "user") avatarId = world.ops.ensureAvatar(req.auth.user.id).id;
    stream();

    socket.on("message", async (raw) => {
      let msg: ClientMessage;
      try {
        const parsed = ClientMessage.safeParse(JSON.parse(String(raw)));
        if (!parsed.success) return fail(`bad message: ${parsed.error.issues[0]?.message ?? "invalid"}`);
        msg = parsed.data;
      } catch {
        return fail("bad message: not JSON");
      }
      try {
        if (msg.type === "auth") {
          const auth = resolveToken(world, msg.token);
          if (!auth || auth.kind !== "user") { fail("auth failed: need a valid user token"); socket.close(4001, "unauthorized"); return; }
          avatarId = world.ops.ensureAvatar(auth.user.id).id;
          stream();
          return;
        }
        if (!avatarId) return fail("read-only guest: sign in (send auth first) to move or talk");
        const owner = world.agents.get(avatarId)?.ownerUserId;
        if (owner && !canInteract(world, owner)) return fail(ASK_FIRST);
        if (msg.type === "human.move") {
          if (!world.moveHuman(avatarId, msg.x, msg.y)) {
            const a = world.agents.get(avatarId);
            if (a) send({ type: "agents.pos", positions: [{ id: a.id, x: a.pos.x, y: a.pos.y, status: a.status }] });
          }
          return;
        }
        if (msg.type === "human.say") {
          await world.verbs.say(avatarId, { text: msg.text });
        }
      } catch (e) {
        fail(isAppError(e) ? e.message : "internal error");
        if (!isAppError(e)) app.log.error({ err: e }, "[server] ws handler error");
      }
    });

    socket.on("close", (code: number) => { if (!WS_NORMAL_CLOSE.has(code)) app.monitor?.counters.wsError(); gone(); });
    socket.on("error", () => { app.monitor?.counters.wsError(); gone(); });
  });
}
