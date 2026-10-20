import { isAppError } from "@agent-town/core";
import { ClientMessage, type ServerMessage } from "@agent-town/schema";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { resolveToken } from "./context.ts";

/** Drop a client that falls this far behind instead of buffering without bound. */
const MAX_BUFFERED = 8 * 1024 * 1024;

/**
 * WS `/ws`: on connect, a snapshot and live `world.changes`. A handshake carrying a user (session cookie or bearer
 * header) is signed in at once (snapshot has `avatarAgentId`); otherwise the socket is a read-only guest until an
 * `auth` message (→ a fresh snapshot with `avatarAgentId`). Client messages: `human.move` (validated walkability),
 * `human.say` (the `say` verb as the avatar); guests get an `error` frame for both.
 */
export async function wsRoutes(app: FastifyInstance) {
  const world = app.world;

  app.get("/ws", { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    let avatarId: string | null = null;
    let unsubscribe: (() => void) | null = null;

    const send = (msg: ServerMessage | (ServerMessage & Record<string, unknown>)) => {
      if (socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > MAX_BUFFERED) { socket.close(1013, "too slow"); return; }
      socket.send(JSON.stringify(msg));
    };
    const fail = (message: string) => send({ type: "error", message });
    /** snapshot first, then stream; subscribe synchronously after so nothing falls in between */
    const stream = () => {
      unsubscribe?.();
      send(avatarId ? { ...world.snapshot(), avatarAgentId: avatarId } : world.snapshot());
      unsubscribe = world.changes.subscribe(send);
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

    socket.on("close", () => { unsubscribe?.(); unsubscribe = null; });
    socket.on("error", () => { unsubscribe?.(); unsubscribe = null; });
  });
}
