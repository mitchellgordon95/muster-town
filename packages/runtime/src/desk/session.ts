/**
 * Desk work sessions: the runtime starts the Session row, makes sure the agent's desk container runs,
 * `exec`s `agent-town-desk run --session <id>` in it, and ends the session if the desk dies without reporting.
 * The desk itself talks to the town over the agent-scoped API (brief, activity, control, session-end).
 */
import { execFileSync } from "node:child_process";
import { AppError, codeWorkspace } from "@muster-town/core";
import { townEnvBoth, type AllocationAuth, type DeskActivityInput, type Session } from "@muster-town/schema";
import { describeTool } from "../describe.ts";
import { InputChannel } from "../sdk.ts";
import { clipJson, clipThought, fundedBy, fundingFor, homeOf, type Ctx, type Funding, type LiveSession } from "../session.ts";
import { finishWorkSession, preflightWork, walkToDesk } from "../work.ts";
import { DESK_BIN, type DeskBackend } from "./backend.ts";

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

export type DeskAuthMode = AllocationAuth | "none";

/** The env var carrying the API key a desk fails over to when the subscription hits its spend limit. */
export const FALLBACK_KEY_ENV = "AGENT_TOWN_FALLBACK_API_KEY";

/**
 * Credentials for a desk session from its funding. Subscription → `CLAUDE_CODE_OAUTH_TOKEN` from the collective's
 * .env (ANTHROPIC_API_KEY is then NOT passed, since Claude Code prefers an API key when both are set), plus the
 * fallback key in AGENT_TOWN_FALLBACK_API_KEY when there is one. Donor-key → the donor's key. Api-key → the
 * funding's key or the env's ANTHROPIC_API_KEY. Unfunded → the token, else the env key. Values are secrets: never log them.
 */
export function deskAuth(funding: Pick<Funding, "auth" | "apiKey" | "fallback">, env: NodeJS.ProcessEnv = process.env): { mode: DeskAuthMode; env: Record<string, string> } {
  const token = env.CLAUDE_CODE_OAUTH_TOKEN || null;
  const envKey = env.ANTHROPIC_API_KEY || null;
  const sub = (): { mode: DeskAuthMode; env: Record<string, string> } => ({
    mode: "subscription",
    env: { CLAUDE_CODE_OAUTH_TOKEN: token!, ...(funding.fallback?.apiKey ? { [FALLBACK_KEY_ENV]: funding.fallback.apiKey } : {}) },
  });
  if (funding.auth === "donor-key" && funding.apiKey) return { mode: "donor-key", env: { ANTHROPIC_API_KEY: funding.apiKey } };
  if (funding.auth === "subscription" && token) return sub();
  if (funding.auth === "subscription" || funding.auth === "api-key") {
    // a subscription with no token in the env can only run on the key
    const key = funding.auth === "api-key" ? funding.apiKey ?? envKey : funding.fallback?.apiKey ?? envKey;
    if (key) return { mode: "api-key", env: { ANTHROPIC_API_KEY: key } };
  }
  if (token) return sub();
  if (envKey) return { mode: "api-key", env: { ANTHROPIC_API_KEY: envKey } };
  return { mode: "none", env: {} };
}

/**
 * Deprecated fallback (one release): host env vars with this prefix reach every desk with the prefix stripped, with a
 * warning, unless the collective has a secret of that name at the Town Hall (then only its grants count).
 */
export const DESK_ENV_PREFIX = "DESK_ENV_";

/**
 * Collective secrets for this session (docs/secrets.md): those granted to its building, its agent or a skill pinned
 * for it, each logged as a `secret.granted` event without the value. Then the DESK_ENV_* fallback for names the Town
 * Hall doesn't manage. Values are secrets: never log them.
 */
export function grantedSecrets(ctx: Ctx, session: Session, buildingId: string, hostEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const { world } = ctx;
  const out: Record<string, string> = {};
  const managed = new Set(world.secrets.list().map((s) => s.name));
  const log = (name: string, via: string) => world.events.append({ type: "secret.granted", agentId: session.agentId, buildingId, text: `Secret ${name} passed to the desk (${via})`, payload: { name, sessionId: session.id, via } });
  for (const s of world.secrets.forAgent(session.agentId)) {
    out[s.name] = s.value;
    log(s.name, `${s.via} grant`);
  }
  const fallback: string[] = [];
  for (const [k, v] of Object.entries(hostEnv)) {
    const name = k.slice(DESK_ENV_PREFIX.length);
    if (!k.startsWith(DESK_ENV_PREFIX) || v === undefined || !name || managed.has(name)) continue;
    out[name] = v;
    fallback.push(name);
    log(name, "DESK_ENV_ fallback");
  }
  if (fallback.length) console.warn(`[runtime] session ${session.id}: ${fallback.join(", ")} passed from DESK_ENV_* to every desk (deprecated, dropped next release): add them as secrets at the Town Hall with grants`);
  return out;
}

/** Env for `agent-town-desk run` (contract step 3). Values are secrets: never log them. */
export function deskEnv(ctx: Ctx, session: Session, opts: DeskSessionOptions = {}, funding?: Funding): Record<string, string> {
  const { world } = ctx;
  const agent = world.agents.require(session.agentId, "agent");
  const building = world.buildings.require(homeOf(world, agent.id)!, "building");
  const env: Record<string, string> = {
    // both spellings for one release: the desk may run an image from before or after the rename
    // sandbox providers run desks off this host, so they call the town's public URL; docker desks use the host gateway
    ...townEnvBoth("URL", ctx.desks.townUrl?.replace(/\/+$/, "") ?? `http://host.docker.internal:${portOf(ctx.mcpUrl)}`),
    ...townEnvBoth("TOKEN", world.tokens.getOrCreate("agent", agent.id)),
    DESK_MODEL: session.model,
    DESK_MAX_TURNS: String(building.maxTurnsPerSession),
  };
  Object.assign(env, grantedSecrets(ctx, session, building.id));
  const auth = deskAuth(funding ?? fundingFor(world, agent.id));
  Object.assign(env, auth.env);
  env.DESK_AUTH = auth.mode; // a label, not a secret: the desk logs it
  console.log(`[runtime] ${agent.name} session ${session.id} auth: ${auth.mode}${auth.env[FALLBACK_KEY_ENV] ? " (API-key fallback ready)" : ""}`);
  if (codeWorkspace(world.town.get(), building)) {
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
    const mode = deskAuth(funding).mode;
    session = world.ops.startSession(agentId, { purpose: "work", model: agent.model ?? building.model, assignmentId, backend: "docker", funding: mode === "none" ? null : mode });
    ctx.deskAllocations.set(session.id, funding.allocationId);
    ctx.deskFallbacks.set(session.id, funding.fallback?.allocationId ?? null);
    world.events.append({ type: "agent.activity", agentId, buildingId: building.id, text: `Starting work (${fundedBy(mode === "none" ? null : mode)})`, payload: { sessionId: session.id, purpose: "work", backend: "docker", funding: mode } });
    const argv = [DESK_BIN, "run", "--session", session.id];
    const child = backend.exec(handle, argv, deskEnv(ctx, session, opts, funding), (stream, line) => {
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
