/**
 * Thin layer over the Claude Agent SDK: the injectable `query`, a streaming-input channel
 * (so interrupts arrive as the next user message), usage accounting, and a one-shot helper.
 */
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export type { Options, SDKUserMessage };

/** What the runtime needs from a running query (the real SDK `Query` satisfies this). */
export interface QueryHandle extends AsyncIterable<unknown> {
  interrupt?(): Promise<unknown>;
  return?(value?: unknown): Promise<unknown>;
}
export interface QueryParams {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}
export interface Sdk {
  query(params: QueryParams): QueryHandle;
}

/** The real SDK, loaded lazily so tests that inject a fake never spawn Claude Code. */
export const realSdk: Sdk = {
  query(params) {
    let inner: (AsyncGenerator<unknown> & { interrupt(): Promise<unknown> }) | null = null;
    const ready = import("@anthropic-ai/claude-agent-sdk").then((m) => {
      inner = m.query(params as Parameters<typeof m.query>[0]);
      return inner;
    });
    return {
      async *[Symbol.asyncIterator]() {
        yield* await ready;
      },
      async interrupt() {
        return (inner ?? (await ready)).interrupt();
      },
      async return() {
        await (inner ?? (await ready)).return(undefined);
        return undefined;
      },
    };
  },
};

export function userMessage(text: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
}

/** Async-iterable queue of user messages; `close()` ends the stream (the SDK then finishes). */
export class InputChannel implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private waiter: ((v: IteratorResult<SDKUserMessage>) => void) | null = null;
  closed = false;

  push(text: string): boolean {
    if (this.closed) return false;
    const msg = userMessage(text);
    if (this.waiter) { const w = this.waiter; this.waiter = null; w({ value: msg, done: false }); }
    else this.queue.push(msg);
    return true;
  }
  get pending(): number {
    return this.queue.length;
  }
  close(): void {
    this.closed = true;
    if (this.waiter) { const w = this.waiter; this.waiter = null; w({ value: undefined, done: true }); }
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const m = this.queue.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => { this.waiter = resolve; });
      },
      return: () => { this.close(); return Promise.resolve({ value: undefined, done: true }); },
    };
  }
}

// ---- loose views of SDK messages (we only read a few fields) ----
export interface ContentBlock { type: string; text?: string; name?: string; id?: string; input?: unknown; tool_use_id?: string; is_error?: boolean }
export interface LooseMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: ContentBlock[] | string };
  result?: string;
  is_error?: boolean;
  errors?: string[];
  num_turns?: number;
  total_cost_usd?: number;
  usage?: Record<string, number | null | undefined>;
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number }>;
  queued_turn_count?: number;
}

export interface Usage { tokens: number; costUsd: number; turns: number }

/** Tokens (input+output+cache) and cost from a result message. modelUsage is cumulative; fall back to usage. */
export function usageOf(m: LooseMessage): Usage {
  let tokens = 0;
  if (m.modelUsage && Object.keys(m.modelUsage).length) {
    for (const u of Object.values(m.modelUsage)) {
      tokens += (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);
    }
  } else if (m.usage) {
    const u = m.usage;
    tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  }
  return { tokens, costUsd: m.total_cost_usd ?? 0, turns: m.num_turns ?? 0 };
}

export function blocksOf(m: LooseMessage): ContentBlock[] {
  const c = m.message?.content;
  return Array.isArray(c) ? c : [];
}

/** Environment for a session: inherit, plus the donor's API key when the allocation has one. */
export function sessionEnv(apiKey: string | null): Options["env"] | undefined {
  if (!apiKey) return undefined;
  return { ...process.env, ANTHROPIC_API_KEY: apiKey };
}

/** One call, no tools: returns the final text and usage. */
export async function oneShot(sdk: Sdk, opts: { model: string; system: string; prompt: string; apiKey?: string | null }): Promise<Usage & { text: string; error: string | null }> {
  let text = "";
  let usage: Usage = { tokens: 0, costUsd: 0, turns: 0 };
  let error: string | null = null;
  try {
    const q = sdk.query({
      prompt: opts.prompt,
      options: {
        model: opts.model,
        systemPrompt: opts.system,
        tools: [],
        allowedTools: [],
        mcpServers: {},
        maxTurns: 1,
        settingSources: [],
        persistSession: false,
        env: sessionEnv(opts.apiKey ?? null),
      },
    });
    for await (const raw of q) {
      const m = raw as LooseMessage;
      if (m.type === "assistant") {
        const t = blocksOf(m).filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n").trim();
        if (t) text = t;
      } else if (m.type === "result") {
        usage = usageOf(m);
        if (typeof m.result === "string" && m.result.trim()) text = m.result.trim();
        if (m.is_error) error = m.errors?.join("; ") || m.result || "error";
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return { ...usage, text, error };
}
