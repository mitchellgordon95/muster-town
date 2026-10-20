import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import { World } from "@muster-town/core";
import type { VerbName } from "@muster-town/schema";
import { HostBackend, startRuntime, type RuntimeOptions, type Runtime, type Sdk } from "../src/index.ts";
import type { Options, SDKUserMessage } from "../src/sdk.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export interface FakeSession {
  agentId: string | null;
  options: Options;
  /** text of every user message received so far (first = the prompt) */
  received: string[];
  /** wait for the next streamed user message (an interrupt); undefined when input closed */
  next(): Promise<string | undefined>;
  interrupted: boolean;
  world: World;
}
export type Script = (s: FakeSession) => AsyncGenerator<unknown, void, unknown>;

const textOf = (m: SDKUserMessage) => (typeof m.message.content === "string" ? m.message.content : JSON.stringify(m.message.content));

export function fakeSdk(world: World, script: Script): Sdk & { sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];
  return {
    sessions,
    query({ prompt, options = {} }) {
      const town = options.mcpServers?.town as { headers?: Record<string, string> } | undefined;
      const token = town?.headers?.Authorization?.replace(/^Bearer /, "");
      const agentId = token ? world.tokens.resolve(token)?.id ?? null : null;
      let iter: AsyncIterator<SDKUserMessage> | null = null;
      const s: FakeSession = {
        agentId, options, received: [], interrupted: false, world,
        async next() {
          if (!iter) return undefined;
          const r = await iter.next();
          if (r.done) return undefined;
          s.received.push(textOf(r.value));
          return textOf(r.value);
        },
      };
      sessions.push(s);
      async function* run() {
        if (typeof prompt === "string") s.received.push(prompt);
        else { iter = prompt[Symbol.asyncIterator](); await s.next(); }
        yield* script(s);
      }
      const gen = run();
      return Object.assign(gen, { async interrupt() { s.interrupted = true; } });
    },
  };
}

// ---- message builders ----
let n = 0;
export const init = () => ({ type: "system", subtype: "init", session_id: "sdk-session-1", tools: [] });
export const text = (t: string) => ({ type: "assistant", session_id: "sdk-session-1", message: { content: [{ type: "text", text: t }] } });
export const toolUse = (name: string, input: unknown, id = `tu_${++n}`) => ({ type: "assistant", session_id: "sdk-session-1", message: { content: [{ type: "tool_use", id, name, input }] } });
export const toolResult = (id: string, content: unknown, isError = false) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: JSON.stringify(content), is_error: isError }] } });
export const result = (tokens: number, costUsd: number, finalText = "done") => ({
  type: "result", subtype: "success", is_error: false, result: finalText, num_turns: 4, total_cost_usd: costUsd, session_id: "sdk-session-1",
  usage: { input_tokens: tokens, output_tokens: 0 },
  modelUsage: { "claude-opus-5-5": { inputTokens: Math.floor(tokens / 2), outputTokens: tokens - Math.floor(tokens / 2), cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: costUsd } },
});

/** Simulate an MCP round trip: emit tool_use, run the verb in-process, emit the tool_result. */
export async function* callVerb(s: FakeSession, verb: VerbName, input: Record<string, unknown>): AsyncGenerator<unknown, unknown, unknown> {
  const id = `tu_${++n}`;
  yield toolUse(`mcp__town__${verb}`, input, id);
  try {
    const out = await (s.world.verbs[verb] as (a: string, i: unknown) => Promise<unknown>)(s.agentId!, input);
    yield toolResult(id, out);
    return out;
  } catch (e) {
    yield toolResult(id, { error: String(e) }, true);
    return null;
  }
}

/** Seeded world (:memory:) with the Carbon Cycle Lab, plus a runtime driven by `script` (no timer, no export). */
export function setup(script: Script, extra: Partial<RuntimeOptions> = {}) {
  const world = World.open(":memory:");
  const seed = world.seedDefaults({ importDir: join(ROOT, "buildings/carbon-cycle"), townJsonPath: join(ROOT, "town.json") });
  const sdk = fakeSdk(world, script);
  const clock = { t: new Date("2026-10-19T10:00:00Z").getTime() };
  const runtime: Runtime = startRuntime({ world, mcpUrl: "http://127.0.0.1:4321/mcp", sdk, intervalMs: 0, exportDir: false, now: () => new Date(clock.t), deskBackend: new HostBackend(), ...extra });
  const by = (name: string) => world.agents.first("name = ?", [name])!;
  cleanups.push(async () => { await runtime.stop(); world.close(); });
  return { world, seed, sdk, runtime, clock, by, lab: seed.lab! };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
