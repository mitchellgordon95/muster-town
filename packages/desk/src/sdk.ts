/**
 * Small copies of the runtime's SDK helpers (the desk image ships only schema + desk):
 * an injectable `query`, a streaming-input channel, and usage extraction.
 */
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export type { Options, SDKUserMessage };

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
