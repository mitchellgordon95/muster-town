/**
 * Thin layer over the Claude Agent SDK: the injectable `query`, a streaming-input channel
 * (so interrupts arrive as the next user message), usage accounting, and a one-shot helper.
 */
import { addUsage, rawTokens, sdkTokenCounts, ZERO_TOKENS, type TokenUsage } from "@muster-town/schema";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

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
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number }>;
  queued_turn_count?: number;
}

/** A session's usage: the raw total (`tokens`, the sum of `counts`), the five counters, per model, cost and turns. */
export interface Usage extends TokenUsage { tokens: number; costUsd: number; turns: number }
export const noUsage = (): Usage => ({ tokens: 0, counts: { ...ZERO_TOKENS }, byModel: {}, costUsd: 0, turns: 0 });

/** Tokens by kind (sdkTokenCounts: modelUsage, cumulative, else usage) and cost from a result message. */
export function usageOf(m: LooseMessage): Usage {
  const t = sdkTokenCounts(m);
  return { tokens: rawTokens(t.counts), ...t, costUsd: m.total_cost_usd ?? 0, turns: m.num_turns ?? 0 };
}

/** Two usages added (a session that reran adds its attempts). */
export function plusUsage(a: Usage, b: Usage): Usage {
  const t = addUsage(a, b);
  return { tokens: rawTokens(t.counts), ...t, costUsd: a.costUsd + b.costUsd, turns: a.turns + b.turns };
}

export function blocksOf(m: LooseMessage): ContentBlock[] {
  const c = m.message?.content;
  return Array.isArray(c) ? c : [];
}

/** Host env vars a host session's Claude Code process may see: process basics, proxies, and its model credential. */
const SESSION_ENV_NAMES = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "TZ", "TMPDIR", "TMP", "TEMP", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "SYSTEMROOT", "APPDATA", "LOCALAPPDATA", "USERPROFILE"]);
const SESSION_ENV_PREFIXES = ["LC_", "XDG_", "CLAUDE_", "ANTHROPIC_"];

/** The model credentials Claude Code reads from its env. Claude Code uses a key over the OAuth token when both are set, so a host carries exactly one. */
export const CREDENTIAL_ENVS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

/**
 * The one model credential in `env`, or null. More than one is a hard failure (the server refuses to boot, a session
 * refuses to start): from 2026-10-22 to 2026-10-30 the host carried both a subscription token and an API key, every
 * host session was handed both, and Claude Code billed the key while the town recorded the subscription
 * (docs/postmortem-2026-10-30-api-key-leak.md). A key the town may spend is a Bank input with its key, or a donor's.
 */
export function assertOneCredential(env: NodeJS.ProcessEnv = process.env): (typeof CREDENTIAL_ENVS)[number] | null {
  const set = CREDENTIAL_ENVS.filter((k) => env[k]);
  if (set.length > 1) throw new Error(`${set.join(" and ")} are both set: the town runs on one model credential (the subscription token, or an API key). Unset one; an API key the town may spend is a Bank input at the Town Hall.`);
  return set[0] ?? null;
}

/** The host's own API key as a funding source: its one credential, when that is a key (never beside a token: `assertOneCredential`). */
export function hostApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.CLAUDE_CODE_OAUTH_TOKEN ? null : env.ANTHROPIC_API_KEY || null;
}

/**
 * Environment for a host session: an allowlist of the host env (never `{...process.env}`, which holds host secrets:
 * the admin and deploy tokens, OAuth client secret, data key, DESK_ENV_*), carrying exactly one model credential:
 * `apiKey` (the funding's own: a donor's or a Bank input's) → `ANTHROPIC_API_KEY`; else the host's subscription token;
 * else the host's API key (a host with no token). Never both: Claude Code prefers the key, which is how every host
 * session ran on the API key from 2026-10-22 to 2026-10-30 while recorded as subscription-funded.
 */
export function sessionEnv(apiKey: string | null, hostEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(hostEnv)) {
    if (v !== undefined && (SESSION_ENV_NAMES.has(k) || SESSION_ENV_PREFIXES.some((p) => k.startsWith(p)))) env[k] = v;
  }
  assertOneCredential(hostEnv);
  for (const k of CREDENTIAL_ENVS) delete env[k];
  const key = apiKey || hostApiKey(hostEnv);
  if (key) env.ANTHROPIC_API_KEY = key;
  else if (hostEnv.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = hostEnv.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}

/**
 * The host env a hosted collective's runtime sees (docs/hosted-collectives.md): the same allowlist built from scratch, with
 * no CLAUDE_*, ANTHROPIC_* or XDG_* (no host key, subscription token or config dir) and its own HOME and CLAUDE_CONFIG_DIR
 * under the collective's dir, so a session never finds the host's ~/.claude login. Its only key is the one funding passes.
 */
export function hostedEnv(dir: string, hostEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(hostEnv)) {
    if (v !== undefined && !HOSTED_DROP.has(k) && (SESSION_ENV_NAMES.has(k) || k.startsWith("LC_"))) env[k] = v;
  }
  env.HOME = join(dir, "home");
  env.CLAUDE_CONFIG_DIR = join(dir, "claude");
  for (const d of [env.HOME, env.CLAUDE_CONFIG_DIR]) mkdirSync(d, { recursive: true });
  return env;
}
const HOSTED_DROP = new Set(["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]);

/** One call, no tools: returns the final text and usage. `env`: the host env to allowlist from (a hosted runtime's own). */
export async function oneShot(sdk: Sdk, opts: { model: string; system: string; prompt: string; apiKey?: string | null; env?: NodeJS.ProcessEnv }): Promise<Usage & { text: string; error: string | null }> {
  let text = "";
  let usage: Usage = noUsage();
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
        env: sessionEnv(opts.apiKey ?? null, opts.env),
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
