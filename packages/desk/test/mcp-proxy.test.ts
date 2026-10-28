import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { GAVE_UP, MAYBE_RAN, startMcpProxy, type McpProxy } from "../src/mcp-proxy.ts";
import { TownClient } from "../src/town.ts";

/** A fake town `/mcp`: `script` answers each request in turn (the last one repeats); `ran` counts the calls it handled. */
async function fakeMcp(script: ((req: IncomingMessage, res: ServerResponse, body: string) => void)[], port = 0) {
  const state = { ran: [] as string[], seen: 0 };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => script[Math.min(state.seen++, script.length - 1)]!(req, res, body));
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return Object.assign(state, {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  });
}

/** The town handling the call: record it, answer a tool result. */
const answer = (state: { ran: string[] }) => (req: IncomingMessage, res: ServerResponse, body: string) => {
  const m = JSON.parse(body);
  state.ran.push(`${m.method}:${m.params?.name ?? ""}:${req.headers.authorization}`);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ok" }] } }));
};
const status = (code: number) => (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(code, { "content-type": "application/json", ...(code === 503 ? { "retry-after": "5" } : {}) });
  res.end(JSON.stringify({ restarting: true }));
};
/** headers sent, then the connection dies mid-answer: the call may have run */
const cut = (state: { ran: string[] }) => (_req: IncomingMessage, res: ServerResponse, body: string) => {
  state.ran.push(`cut:${JSON.parse(body).params?.name}`);
  res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
  res.write('{"jsonrpc":"2.0",');
  setTimeout(() => res.socket?.destroy(), 5);
};

const call = (url: string, name: string, id = 1) => fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer tok" },
  body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } }),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

let proxy: McpProxy | null = null;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await proxy?.close();
  proxy = null;
  for (const c of closers.splice(0)) await c();
});

describe("desk MCP proxy: riding out a town restart", () => {
  it("passes a call through with its auth header", async () => {
    const town = { ran: [] as string[] };
    const s = await fakeMcp([answer(town)]);
    closers.push(s.close);
    proxy = await startMcpProxy({ target: `http://127.0.0.1:${s.port}/mcp`, backoffMs: [5] });
    const r = await call(proxy.url, "write");
    expect(r).toEqual({ status: 200, body: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } } });
    expect(town.ran).toEqual(["tools/call:write:Bearer tok"]);
  });

  it("502, then 503 restarting, then the town answers: the call runs once and the model sees its result", async () => {
    const ran = { ran: [] as string[] };
    const s = await fakeMcp([status(502), status(503), answer(ran)]);
    closers.push(s.close);
    proxy = await startMcpProxy({ target: `http://127.0.0.1:${s.port}/mcp`, backoffMs: [5, 5, 5, 5] });
    const r = await call(proxy.url, "submit_report");
    expect(r.body.result.content[0].text).toBe("ok");
    expect(s.seen).toBe(3);
    expect(ran.ran).toEqual(["tools/call:submit_report:Bearer tok"]);
  });

  it("connection refused while the town is down, then it comes back on the same port: the call runs once", async () => {
    const probe = await fakeMcp([]);
    const port = probe.port;
    await probe.close(); // nothing listens: connection refused
    const ran = { ran: [] as string[] };
    proxy = await startMcpProxy({ target: `http://127.0.0.1:${port}/mcp`, backoffMs: [20, 20, 20, 20, 20, 20, 20, 20, 20, 20] });
    const pending = call(proxy.url, "write");
    await new Promise((r) => setTimeout(r, 60));
    const back = await fakeMcp([answer(ran)], port);
    closers.push(back.close);
    const r = await pending;
    expect(r.body.result.content[0].text).toBe("ok");
    expect(ran.ran).toEqual(["tools/call:write:Bearer tok"]);
  });

  it("a write cut mid-answer is not resent: the model gets a tool error telling it to check first", async () => {
    const ran = { ran: [] as string[] };
    const s = await fakeMcp([cut(ran), answer(ran)]);
    closers.push(s.close);
    proxy = await startMcpProxy({ target: `http://127.0.0.1:${s.port}/mcp`, backoffMs: [5, 5] });
    const r = await call(proxy.url, "write", 7);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: MAYBE_RAN }], isError: true } });
    expect(ran.ran).toEqual(["cut:write"]);
  });

  it("a read-only tool cut mid-answer is resent", async () => {
    const ran = { ran: [] as string[] };
    const s = await fakeMcp([cut(ran), answer(ran)]);
    closers.push(s.close);
    proxy = await startMcpProxy({ target: `http://127.0.0.1:${s.port}/mcp`, backoffMs: [5, 5] });
    const r = await call(proxy.url, "look");
    expect(r.body.result.content[0].text).toBe("ok");
    expect(ran.ran).toEqual(["cut:look", "tools/call:look:Bearer tok"]);
  });

  it("gives up after the backoff with a tool error (bounded)", async () => {
    const s = await fakeMcp([status(503)]);
    closers.push(s.close);
    proxy = await startMcpProxy({ target: `http://127.0.0.1:${s.port}/mcp`, backoffMs: [5, 5] });
    const r = await call(proxy.url, "write", 3);
    expect(r.body).toEqual({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: GAVE_UP }], isError: true } });
    expect(s.seen).toBe(3);
  });
});

describe("TownClient through a restart", () => {
  it("retries 503 restarting and connection refused on the restart backoff, then gets the answer", async () => {
    let n = 0;
    const s = await fakeMcp([status(503), status(502), (_req, res) => { n++; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ interrupts: [], stop: false })); }]);
    closers.push(s.close);
    const c = new TownClient({ baseUrl: `http://127.0.0.1:${s.port}`, token: "t", backoffMs: [], restartBackoffMs: [5, 5, 5] });
    expect(await c.control("s1")).toEqual({ interrupts: [], stop: false });
    expect(n).toBe(1);
  });

  it("a plain 500 still gives up on the short backoff", async () => {
    const s = await fakeMcp([status(500)]);
    closers.push(s.close);
    const c = new TownClient({ baseUrl: `http://127.0.0.1:${s.port}`, token: "t", backoffMs: [1], restartBackoffMs: [1, 1, 1, 1] });
    await expect(c.control("s1")).rejects.toThrow("500");
    expect(s.seen).toBe(2);
  });
});
