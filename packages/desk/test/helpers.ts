import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DeskActivityInput, DeskBriefView as DeskBrief, DeskControl, DeskSessionEndInput } from "@muster-town/schema";
import type { QueryHandle, QueryParams, Sdk, SDKUserMessage } from "../src/sdk.ts";

export const TOKEN = "agent-token-1";

export interface FakeTown {
  url: string;
  briefs: Map<string, DeskBrief>;
  activity: DeskActivityInput[];
  control: DeskControl;
  acked: string[];
  ends: DeskSessionEndInput[];
  /** POST /api/agents/me/transcript bodies (brotli), by session */
  transcripts: Map<string, Buffer>;
  requests: string[];
  close(): Promise<void>;
}

/** A real HTTP server implementing the five agent-scoped endpoints in memory. */
export async function startFakeTown(): Promise<FakeTown> {
  const state = {
    briefs: new Map<string, DeskBrief>(),
    activity: [] as DeskActivityInput[],
    control: { interrupts: [], stop: false } as DeskControl,
    acked: [] as string[],
    ends: [] as DeskSessionEndInput[],
    transcripts: new Map<string, Buffer>(),
    requests: [] as string[],
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const u = new URL(req.url ?? "/", "http://x");
      state.requests.push(`${req.method} ${u.pathname}`);
      const send = (status: number, body?: unknown) => {
        res.writeHead(status, body === undefined ? {} : { "Content-Type": "application/json" });
        res.end(body === undefined ? undefined : JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "bad token" });
      const key = `${req.method} ${u.pathname}`;
      if (key === "POST /api/agents/me/transcript") { state.transcripts.set(u.searchParams.get("session") ?? "", Buffer.concat(chunks)); return send(201, { transcript: {} }); }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      if (key === "GET /api/agents/me/brief") {
        const b = state.briefs.get(u.searchParams.get("session") ?? "");
        return b ? send(200, b) : send(403, { error: "not your session" });
      }
      if (key === "POST /api/agents/me/activity") { state.activity.push(body); return send(204); }
      if (key === "GET /api/agents/me/control") {
        const c = { interrupts: state.control.interrupts.filter((i) => !state.acked.includes(i.id)), stop: state.control.stop };
        return send(200, c);
      }
      if (key === "POST /api/agents/me/control/ack") { state.acked.push(...body.ids); return send(204); }
      if (key === "POST /api/agents/me/session-end") { state.ends.push(body); return send(200, { session: { id: body.session } }); }
      if (key === "GET /api/health") return send(200, { ok: true });
      send(404, { error: "not found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  });
}

export function brief(sessionId: string, over: Partial<DeskBrief> = {}): DeskBrief {
  return {
    agent: { id: "a1", name: "Ada" },
    building: { id: "b1", name: "Carbon Lab", maxTurnsPerSession: 40 },
    town: { name: "Muster Town" },
    assignment: { id: "as1", title: "Measure CO2" },
    session: { id: sessionId, model: "claude-opus-5-5" },
    system: "You are Ada.",
    prompt: "Do the assignment.",
    workspace: null,
    ...over,
  };
}

// ---- fake SDK ----
export interface FakeSession {
  params: QueryParams;
  received: string[];
  interrupted: boolean;
  /** resolves when interrupt() is called */
  interruptedSignal: Promise<void>;
}
/** One turn per user message; yields that turn's messages. A result is appended automatically unless the turn yields one. */
export type Turn = (s: FakeSession, text: string, turn: number) => AsyncGenerator<unknown, void, unknown>;

export const result = (turns: number, extra: Record<string, unknown> = {}) => ({
  type: "result", subtype: "success", session_id: "sdk-1", is_error: false, num_turns: turns, result: "",
  total_cost_usd: 0.5 * turns, modelUsage: { m: { inputTokens: 100 * turns, outputTokens: 10 * turns } }, ...extra,
});
export const assistant = (...content: unknown[]) => ({ type: "assistant", session_id: "sdk-1", message: { content } });
export const toolResult = (id: string, isError = false) => ({ type: "user", session_id: "sdk-1", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError }] } });

export function fakeSdk(turn: Turn): Sdk & { sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];
  return {
    sessions,
    query(params): QueryHandle {
      let fire!: () => void;
      const s: FakeSession = { params, received: [], interrupted: false, interruptedSignal: new Promise<void>((r) => { fire = r; }) };
      sessions.push(s);
      // like the real SDK, interrupt() aborts only the current turn; queued user messages still run after it
      let abort = false;
      // like the real SDK, the prompt stream is read eagerly: a pushed message leaves the desk's channel at once
      const taken: SDKUserMessage[] = [];
      let wake = null as (() => void) | null;
      let ended = false as boolean;
      void (async () => {
        for await (const msg of params.prompt as AsyncIterable<SDKUserMessage>) { taken.push(msg); wake?.(); }
        ended = true; wake?.();
      })();
      const prompts = async function* () {
        for (;;) {
          const m = taken.shift();
          if (m) { yield m; continue; }
          if (ended) return;
          await new Promise<void>((r) => { wake = r; });
          wake = null;
        }
      };
      const gen = (async function* () {
        let n = 0;
        for await (const msg of prompts()) {
          const text = String(msg.message.content);
          s.received.push(text);
          n++;
          let sawResult = false;
          abort = false;
          for await (const m of turn(s, text, n)) {
            if ((m as { type?: string }).type === "result") sawResult = true;
            yield m;
            if (abort) break;
          }
          // what production showed (10-31): an interrupt crossing a running turn drops the prompt that turn took in, and the
          // aborted result reports nothing queued
          if (abort) { taken.splice(0); yield result(n, { subtype: "error_during_execution", is_error: true, errors: ["interrupted"], queued_turn_count: 0 }); continue; }
          if (!sawResult) yield result(n, { queued_turn_count: taken.length });
        }
      })();
      return {
        [Symbol.asyncIterator]: () => gen,
        async interrupt() { s.interrupted = true; abort = true; fire(); return undefined; },
        async return() { await gen.return(undefined); return undefined; },
      };
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
