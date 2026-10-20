/**
 * Desk work sessions: the runtime starts the Session row, makes sure the agent's desk container runs,
 * `exec`s `agent-town-desk run --session <id>` in it, and ends the session if the desk dies without reporting.
 * The desk itself talks to the town over the agent-scoped API (brief, activity, control, session-end).
 */
import { execFileSync } from "node:child_process";
import { AppError } from "@agent-town/core";
import type { DeskActivityInput, Session } from "@agent-town/schema";
import { describeTool } from "../describe.ts";
import { InputChannel } from "../sdk.ts";
import { clipJson, clipThought, fundingFor, homeOf, type Ctx, type LiveSession } from "../session.ts";
import { finishWorkSession, preflightWork, walkToDesk } from "../work.ts";
import type { DeskBackend } from "./backend.ts";

export interface DeskSessionOptions {
  /** GH_TOKEN for workspace buildings (default: per `desks.ghToken`, cached) */
  ghToken?: () => string | null;
}

let ghCache: { token: string | null } | null = null;
/** `gh auth token` on the host, cached for the process. Never logged. */
export function ghCliToken(): string | null {
  if (ghCache) return ghCache.token;
  try {
    const t = execFileSync("gh", ["auth", "token"], { stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).toString().trim();
    ghCache = { token: t || null };
  } catch {
    ghCache = { token: null };
  }
  return ghCache.token;
}

/** Port of the server, from its MCP URL (http://127.0.0.1:4321/mcp → 4321). */
export function portOf(mcpUrl: string): string {
  try {
    const u = new URL(mcpUrl);
    return u.port || (u.protocol === "https:" ? "443" : "80");
  } catch {
    return "4321";
  }
}

export type DeskAuthMode = "donor key" | "subscription token" | "env api key" | "none";

/**
 * How a desk session is funded, in order: a donor API key (the allocation has one) → `CLAUDE_CODE_OAUTH_TOKEN`
 * from the collective's .env (a Claude subscription token; ANTHROPIC_API_KEY is then NOT passed, since Claude Code
 * prefers an API key when both are set) → `ANTHROPIC_API_KEY` from the env. Values are secrets: never log them.
 */
export function deskAuth(donorKey: string | null | undefined, env: NodeJS.ProcessEnv = process.env): { mode: DeskAuthMode; env: Record<string, string> } {
  if (donorKey) return { mode: "donor key", env: { ANTHROPIC_API_KEY: donorKey } };
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { mode: "subscription token", env: { CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN } };
  if (env.ANTHROPIC_API_KEY) return { mode: "env api key", env: { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY } };
  return { mode: "none", env: {} };
}

/** Env for `agent-town-desk run` (contract step 3). Values are secrets: never log them. */
export function deskEnv(ctx: Ctx, session: Session, opts: DeskSessionOptions = {}): Record<string, string> {
  const { world } = ctx;
  const agent = world.agents.require(session.agentId, "agent");
  const building = world.buildings.require(homeOf(world, agent.id)!, "building");
  const env: Record<string, string> = {
    AGENT_TOWN_URL: `http://host.docker.internal:${portOf(ctx.mcpUrl)}`,
    AGENT_TOWN_TOKEN: world.tokens.getOrCreate("agent", agent.id),
    DESK_MODEL: session.model,
    DESK_MAX_TURNS: String(building.maxTurnsPerSession),
  };
  const auth = deskAuth(fundingFor(world, agent.id).apiKey);
  Object.assign(env, auth.env);
  env.DESK_AUTH = auth.mode; // a label, not a secret: the desk logs it
  console.log(`[runtime] ${agent.name} session ${session.id} auth: ${auth.mode}`);
  if (building.workspace) {
    const mode = ctx.desks.ghToken;
    const gh = opts.ghToken ? opts.ghToken() : mode === "gh-cli" ? ghCliToken() : mode === "env" ? process.env.GH_TOKEN ?? null : null;
    if (gh) env.GH_TOKEN = gh;
  }
  return env;
}

/**
 * Run one work session in the agent's desk. Resolves with the ended session (after the desk process exits).
 * Throws like the host path when the agent can't start.
 */
export async function runDeskSession(ctx: Ctx, backend: DeskBackend, starting: Set<string>, agentId: string, assignmentId: string, opts: DeskSessionOptions = {}): Promise<Session> {
  const { world } = ctx;
  const { agent, building } = preflightWork(ctx, starting, agentId, assignmentId);
  starting.add(agentId);
  let live: LiveSession | null = null;
  let session: Session | null = null;
  try {
    walkToDesk(ctx, agent);
    const handle = await backend.ensure(agent, building);
    const funding = fundingFor(world, agentId);
    session = world.ops.startSession(agentId, { purpose: "work", model: agent.model ?? building.model, assignmentId, backend: "docker" });
    ctx.deskAllocations.set(session.id, funding.allocationId);
    const argv = ["agent-town-desk", "run", "--session", session.id];
    const child = backend.exec(handle, argv, deskEnv(ctx, session, opts), (stream, line) => {
      (stream === "stderr" ? console.warn : console.log)(`[desk ${handle.name}] ${line}`);
    });
    live = { kind: "desk", agentId, sessionId: session.id, purpose: "work", input: new InputChannel(), q: null, reportSubmitted: false, stopped: false, child };
    live.input.close();
    ctx.live.set(agentId, live);
    starting.delete(agentId);
    const code = await child.wait();
    if (world.sessions.get(session.id)?.status === "running") {
      return await finishWorkSession(ctx, session.id, { error: `desk exited ${code}`, stopped: live.stopped });
    }
    return world.sessions.require(session.id);
  } catch (e) {
    // couldn't start the desk: end the session (if created) as an error so the agent isn't stuck "working"
    if (session && world.sessions.get(session.id)?.status === "running") {
      await finishWorkSession(ctx, session.id, { error: `desk failed: ${e instanceof Error ? e.message : String(e)}`, stopped: live?.stopped });
    }
    throw e;
  } finally {
    starting.delete(agentId);
    if (live && ctx.live.get(agentId) === live) ctx.live.delete(agentId);
  }
}

/** POST /api/agents/me/activity: turn a desk's tool call / thought / status into the same events as in-process sessions. */
export function onDeskActivity(ctx: Ctx, agentId: string, input: DeskActivityInput): void {
  const { world } = ctx;
  const s = world.sessions.require(input.session, "session");
  if (s.agentId !== agentId) throw new AppError("forbidden", "Not your session.");
  if (s.status !== "running") throw new AppError("conflict", `Session ${s.id} is ${s.status}.`);
  const bid = homeOf(world, agentId);
  const base = { sessionId: s.id, purpose: s.purpose, backend: s.backend };
  if (input.kind === "tool") {
    const tool = input.tool ?? "tool";
    world.events.append({ type: "agent.tool", agentId, buildingId: bid, text: describeTool(world, tool, input.input), payload: { ...base, tool, input: clipJson(input.input) } });
    const live = ctx.live.get(agentId);
    if (live?.sessionId === s.id && tool === "mcp__town__submit_report") live.reportSubmitted = true;
  } else if (input.kind === "thought") {
    const t = (input.text ?? "").trim();
    if (t) world.events.append({ type: "agent.thought", agentId, buildingId: bid, text: clipThought(t), payload: base });
  } else {
    const t = (input.text ?? "").trim();
    if (t) world.events.append({ type: "agent.activity", agentId, buildingId: bid, text: t.slice(0, 200), payload: base });
  }
}
