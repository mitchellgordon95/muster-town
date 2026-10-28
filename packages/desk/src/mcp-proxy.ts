/**
 * The desk's MCP proxy (docs/architecture.md "Redeploy"): Claude Code's `town` MCP server points at this
 * 127.0.0.1 proxy, which forwards each request to the town's `/mcp`. A redeploy restarts the town while the session keeps
 * running, so a tool call can land in the few seconds the town is down. The proxy then waits and sends it again
 * (RESTART_BACKOFF_MS), so the model sees one slow call instead of a failed one.
 *
 * It only resends a request that provably never ran: connection refused, or a 502/503/504. A connection cut after the
 * request was sent may have run it, so the proxy answers with a tool error that says so (the model checks before
 * repeating, so a write or a report is never filed twice), except for read-only tools, which are always safe to resend.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { RESTART_BACKOFF_MS, restarting } from "./restart.ts";

/** Town tools that change nothing (inbox only marks messages read): resent even when a cut call may have run. */
export const READ_ONLY_TOOLS = new Set(["look", "read", "search", "board", "inbox", "assignments", "skills"]);

/** Request headers passed on to the town (the rest are hop-by-hop or the proxy's own). */
const FORWARD = ["authorization", "content-type", "accept", "mcp-protocol-version", "mcp-session-id", "last-event-id"];
/** Response headers passed back. */
const BACK = ["content-type", "mcp-session-id", "mcp-protocol-version"];

export const MAYBE_RAN = "The town restarted during this call, so it may or may not have happened. Check with look, read, inbox or search before repeating it (a repeated write files a second doc unless you pass its id).";
export const GAVE_UP = "The town is restarting and did not answer for several minutes. Try this call again in a minute.";

export interface McpProxyOptions {
  /** the town's MCP endpoint, e.g. https://muster.town/workshop/mcp */
  target: string;
  fetch?: typeof fetch;
  /** waits between attempts while the town restarts (default RESTART_BACKOFF_MS) */
  backoffMs?: number[];
  log?: (line: string) => void;
}

export interface McpProxy {
  /** the URL to give Claude Code (http://127.0.0.1:<port>/mcp) */
  url: string;
  close(): Promise<void>;
}

/** Network errors where the connection was never made, so the town never saw the request. */
const NEVER_CONNECTED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
function neverConnected(e: unknown): boolean {
  for (let c: unknown = e, i = 0; c && i < 5; c = (c as { cause?: unknown }).cause, i++) {
    const code = (c as { code?: unknown }).code;
    if (typeof code === "string" && NEVER_CONNECTED.has(code)) return true;
    // the AggregateError fetch throws when every address refused
    const errors = (c as { errors?: unknown }).errors;
    if (Array.isArray(errors) && errors.length && errors.every((x) => NEVER_CONNECTED.has(String((x as { code?: unknown }).code)))) return true;
  }
  return false;
}

interface RpcMessage { jsonrpc?: string; id?: string | number | null; method?: string; params?: { name?: string } }

/** The JSON-RPC messages in a request body (one, or a batch); none when it isn't JSON. */
function messagesOf(body: Buffer): { msgs: RpcMessage[]; batch: boolean } {
  try {
    const v = JSON.parse(body.toString("utf8")) as unknown;
    return { msgs: (Array.isArray(v) ? v : [v]).filter((m): m is RpcMessage => !!m && typeof m === "object"), batch: Array.isArray(v) };
  } catch {
    return { msgs: [], batch: false };
  }
}

/** Whether resending can't do anything twice: no message is a call to a tool that changes something. */
function safeToResend(msgs: RpcMessage[]): boolean {
  return msgs.length > 0 && msgs.every((m) => m.method !== "tools/call" || READ_ONLY_TOOLS.has(String(m.params?.name ?? "")));
}

/** A reply in the request's own terms: a tool error for a tool call (the model reads it), a JSON-RPC error otherwise. */
function failure({ msgs, batch }: { msgs: RpcMessage[]; batch: boolean }, text: string): { status: number; body: string } {
  const replies = msgs.filter((m) => m.id !== undefined && m.id !== null).map((m) =>
    m.method === "tools/call"
      ? { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text }], isError: true } }
      : { jsonrpc: "2.0", id: m.id, error: { code: -32603, message: text } });
  if (!replies.length) return { status: 503, body: JSON.stringify({ error: text, restarting: true }) };
  return { status: 200, body: JSON.stringify(batch ? replies : replies[0]) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startMcpProxy(opts: McpProxyOptions): Promise<McpProxy> {
  const f = opts.fetch ?? fetch;
  const backoff = opts.backoffMs ?? RESTART_BACKOFF_MS;
  const log = opts.log ?? (() => {});

  async function forward(req: IncomingMessage, body: Buffer): Promise<{ status: number; headers: Record<string, string>; body: Buffer | string }> {
    const headers: Record<string, string> = {};
    for (const h of FORWARD) { const v = req.headers[h]; if (typeof v === "string") headers[h] = v; }
    const method = req.method ?? "POST";
    const rpc = method === "POST" ? messagesOf(body) : { msgs: [], batch: false };
    const msgs = rpc.msgs;
    const json = { "content-type": "application/json" };
    const what = msgs.map((m) => m.method === "tools/call" ? m.params?.name : m.method).filter(Boolean).join(", ") || method;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await f(opts.target, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : new Blob([new Uint8Array(body)]) });
      } catch (e) {
        if (!neverConnected(e) && !safeToResend(msgs)) {
          log(`mcp ${what}: connection cut after sending (${e instanceof Error ? e.message : String(e)}); not resent`);
          const r = failure(rpc, MAYBE_RAN);
          return { status: r.status, headers: json, body: r.body };
        }
        const wait = backoff[attempt];
        if (wait === undefined) { const r = failure(rpc, GAVE_UP); return { status: r.status, headers: json, body: r.body }; }
        if (attempt === 0) log(`mcp ${what}: the town is unreachable (restarting?); retrying for up to ${Math.round(backoff.reduce((a, b) => a + b, 0) / 1000)} s`);
        await sleep(wait);
        continue;
      }
      if (restarting(res.status)) {
        await res.arrayBuffer().catch(() => undefined);
        const wait = backoff[attempt];
        if (wait === undefined) { const r = failure(rpc, GAVE_UP); return { status: r.status, headers: json, body: r.body }; }
        if (attempt === 0) log(`mcp ${what}: the town answered ${res.status} (restarting?); retrying`);
        const after = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, wait) : wait);
        continue;
      }
      // the whole answer, then reply: a cut mid-answer must become a clear error, not half a stream
      let out: Buffer;
      try {
        out = Buffer.from(await res.arrayBuffer());
      } catch (e) {
        if (safeToResend(msgs) && backoff[attempt] !== undefined) { await sleep(backoff[attempt]!); continue; }
        log(`mcp ${what}: the answer was cut (${e instanceof Error ? e.message : String(e)}); not resent`);
        const r = failure(rpc, MAYBE_RAN);
        return { status: r.status, headers: json, body: r.body };
      }
      if (attempt > 0) log(`mcp ${what}: the town answered after ${attempt} retr${attempt === 1 ? "y" : "ies"}`);
      const back: Record<string, string> = {};
      for (const h of BACK) { const v = res.headers.get(h); if (v) back[h] = v; }
      return { status: res.status, headers: back, body: out };
    }
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      forward(req, Buffer.concat(chunks)).then((r) => {
        res.writeHead(r.status, r.headers);
        res.end(r.body);
      }, (e: unknown) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
