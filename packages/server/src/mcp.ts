import { isAppError, type World } from "@agent-town/core";
import { VERB_DESCRIPTIONS, VERB_NAMES, VerbInputs, type VerbName } from "@agent-town/schema";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance } from "fastify";
import type { ZodRawShape } from "zod";
import { bearer, resolveToken } from "./context.ts";
import { runVerb } from "./routes/verbs.ts";

function text(t: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

/** One MCP server whose tools are the verbs, acting as `agentId`. */
export function buildMcpServer(world: World, agentId: string): McpServer {
  const server = new McpServer({ name: "agent-town", version: "0.1.0" });
  for (const name of VERB_NAMES) {
    const shape = VerbInputs[name].shape as ZodRawShape;
    server.registerTool(name, { description: VERB_DESCRIPTIONS[name as VerbName], inputSchema: shape }, async (args: unknown) => {
      try {
        // same path as POST /api/verbs/:verb: stamps presence, then runs the verb
        const result = await runVerb(world, agentId, name, args ?? {});
        return text(JSON.stringify(result ?? null));
      } catch (e) {
        if (!isAppError(e)) console.error(`[server] mcp tool ${name} failed`, e);
        return text(e instanceof Error ? e.message : String(e), true);
      }
    });
  }
  return server;
}

/**
 * `/mcp` (Streamable HTTP, stateless): every POST gets a fresh server + transport bound to the
 * caller's agent. Responses are plain JSON (no SSE), so long tool calls like `go` (≤ 30 s) just
 * hold the request open. GET/DELETE return 405, which the spec allows for servers without a
 * standalone notification stream or sessions.
 */
export async function mcpRoutes(app: FastifyInstance) {
  const world = app.world;
  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    handler: async (req, reply) => {
      const auth = resolveToken(world, bearer(req.headers.authorization));
      if (!auth || auth.kind !== "agent") {
        return reply.code(401).header("WWW-Authenticate", "Bearer").send({ error: "MCP needs an agent token (Authorization: Bearer <agent token>).", code: "unauthorized" });
      }
      if (req.method !== "POST") {
        return reply.code(405).header("Allow", "POST").send({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)." }, id: null });
      }
      const server = buildMcpServer(world, auth.agent.id);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      reply.hijack();
      reply.raw.on("close", () => { void transport.close(); void server.close(); });
      try {
        await server.connect(transport);
        await transport.handleRequest(req.raw, reply.raw, req.body);
      } catch (e) {
        app.log.error({ err: e }, "[server] mcp request failed");
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { "Content-Type": "application/json" });
          reply.raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
        }
      }
    },
  });
}
