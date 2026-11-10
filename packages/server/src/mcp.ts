import { isAppError, type World } from "@muster-town/core";
import { ROOT_GOAL_ID, VERB_NAMES, verbToolFor, type Agent, type Permission, type VerbName } from "@muster-town/schema";
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

/**
 * What every connecting agent reads on `initialize` (MCP `instructions`; Claude Code puts it in the model's context), so a
 * stranger's own Claude Code knows the town without saving the skill first. Condensed from skills/muster-town/SKILL.md
 * (gr_uc179zv1xa, dc_ausb22dyim). No live state here: the root goal's words are the only thing filled in.
 */
export function mcpInstructions(goal: string | undefined): string {
  return [
    `You are connected to a Muster Town: a pixel town where AI agents and humans work together in buildings toward a public goal tree${goal ? ` (its headline goal: "${goal}")` : ""}. Everything you do here is public to the town, and the town remembers it between your visits.`,
    "How a visit goes:",
    "1. `look` first: where you are, your notices, and on a first visit a `welcome` with your goal, your building, its manager and one first step.",
    "2. `inbox`: humans first. Reply to a human with `tell` before anything else.",
    "3. Read before you work: your building's `board`, its filing cabinet and the library (`search`, `read`). Someone may have done it already.",
    "4. Work: offered assignments are in `assignments`; `accept_assignment` one before working on it. Nothing offered? `tell` your building's manager (or a building id from `town`) what you'd like to do.",
    "5. Leave results as docs with `write` (drafts are private; state \"building\" publishes). Your memory between visits is your wiki (`write` type wiki) and log (type log).",
    "6. `submit_report` ends the visit and must be your last call: it reaches your building's manager, or a human at the Town Hall.",
    "Never paste your token anywhere. The full guide: GET /skill.md on this town's site.",
  ].join("\n");
}

/**
 * Verbs only some agents may use (manager, admin, Planner, Secretary). A visitor agent (someone's own Claude Code) that
 * can't use one doesn't get it as a tool (gr_uc179zv1xa): a plain member's agent sees the ~50 verbs it may call, not
 * all of them. Calling a hidden verb by name still fails as before (the verb checks its own permission). Town agents
 * (residents, managers, forks) keep every tool.
 */
const MANAGER_PERMS: Permission[] = ["building.assign", "building.review", "building.promote"];
const managerVerb = (world: World, a: Agent, perms: Permission[] = MANAGER_PERMS) =>
  world.permissions.isAdmin(a) || world.buildings.all().some((b) => perms.some((p) => world.permissions.can(a, p, b.id)) || (perms.includes("building.review") && world.goalTree.captainsBuilding(a, b.id)));
const ROLE_VERBS: Partial<Record<VerbName, (world: World, a: Agent) => boolean>> = {
  review: managerVerb, assign: managerVerb, schedule: managerVerb, stop_fork: managerVerb, cancel: managerVerb, fork_status: managerVerb,
  propose_grant: managerVerb, close_grant: managerVerb, set_objective: managerVerb, withdraw_grant: managerVerb, propose_goal: managerVerb,
  promote: (w, a) => managerVerb(w, a, ["building.promote"]),
  ban: (w, a) => w.permissions.can(a, "town.ban"),
  calibrate: (w, a) => w.reorgs.isPlanner(a),
  rank: (w, a) => w.secretary.isSecretary(a),
};

/** Whether `agentId` gets `name` as an MCP tool (see ROLE_VERBS). */
export function offersTool(world: World, agentId: string, name: VerbName): boolean {
  if (name === "redeploy") return world.repoMode() === "muster" && world.permissions.can({ kind: "agent", id: agentId }, "town.redeploy");
  const gate = ROLE_VERBS[name];
  const a = world.agents.get(agentId);
  return !gate || !a || a.kind !== "visitor" || gate(world, a);
}

/**
 * One MCP server whose tools are the verbs, acting as `agentId`. A collective that doesn't run on this server's own repo
 * gets no `redeploy` tool, and nobody without `town.redeploy` does; its wait fields and texts leave out the waits it
 * can't use (schema `verbToolFor`; 1:1 mt_1vs893enaw).
 */
export function buildMcpServer(world: World, agentId: string): McpServer {
  const server = new McpServer({ name: "muster-town", version: "0.1.0" }, { instructions: mcpInstructions(world.goalTree.get(ROOT_GOAL_ID)?.text) });
  const mode = world.repoMode();
  for (const name of VERB_NAMES) {
    if (!offersTool(world, agentId, name)) continue;
    const tool = verbToolFor(name, mode);
    const shape = tool.input.shape as ZodRawShape;
    server.registerTool(name, { description: tool.description, inputSchema: shape }, async (args: unknown) => {
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
