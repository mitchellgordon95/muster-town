/**
 * Desk work sessions: the runtime starts the Session row, makes sure the agent's desk container runs,
 * `exec`s `agent-town-desk run --session <id>` in it, and ends the session if the desk dies without reporting.
 * The desk itself talks to the town over the agent-scoped API (brief, activity, control, session-end).
 */
import { execFileSync } from "node:child_process";
import { AppError, codeWorkspace, deskPreset, REPO_TOKEN_SECRET, type World } from "@muster-town/core";
import { townEnvBoth, type AllocationAuth, type DeskActivityInput, type DesksConfig, type Session } from "@muster-town/schema";
import { describeTool } from "../describe.ts";
import { assertHostedCredential, assertOneCredential, credentialEnv, InputChannel } from "../sdk.ts";
import { bookRunning, clipJson, clipThought, fundedBy, fundingFor, fundingForSession, homeOf, type Ctx, type Funding, type LiveSession } from "../session.ts";
import { finishWorkSession, preflightWork, walkToDesk } from "../work.ts";
import { DESK_BIN, type DeskBackend } from "./backend.ts";

export interface DeskSessionOptions {
  /** GH_TOKEN for workspace buildings (default: per `desks.ghToken`, cached) */
  ghToken?: () => string | null;
}

let ghCache: { token: string | null } | null = null;
/** `gh auth token` on the host, cached for the process. Never logged. */
function ghCliToken(): string | null {
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

export type DeskAuthMode = AllocationAuth;

/**
 * The credential for a desk session from its funding: exactly one, the Bank's, and no failover key beside it (a session
 * that dies on the subscription's cap makes the next session pick differently: `Budget.failoverFunding`). Subscription →
 * `CLAUDE_CODE_OAUTH_TOKEN` (the subscription input's token); donor-key / api-key → `ANTHROPIC_API_KEY`. Nothing comes
 * from the host env. Values are secrets: never log them.
 */
export function deskAuth(funding: Pick<Funding, "auth" | "credential">): { mode: DeskAuthMode; env: Record<string, string> } {
  return { mode: funding.auth, env: credentialEnv(funding.credential) };
}

/**
 * Collective secrets for this session (docs/secrets.md): those granted to its building, its agent or a skill pinned
 * for it, each logged as a `secret.granted` event without the value. Nothing from the host env: the `DESK_ENV_*`
 * fallback was dropped on 2026-10-25 (one release after the Town Hall secrets shipped). Values are secrets: never log them.
 */
export function grantedSecrets(ctx: Ctx, session: Session, buildingId: string): Record<string, string> {
  const { world } = ctx;
  const out: Record<string, string> = {};
  for (const s of world.secrets.forAgent(session.agentId)) {
    out[s.name] = s.value;
    world.events.append({ type: "secret.granted", agentId: session.agentId, buildingId, text: `Secret ${s.name} passed to the desk (${s.via} grant)`, payload: { name: s.name, sessionId: session.id, via: `${s.via} grant` } });
  }
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
    // a fork's desk slot is shared by the forks before and after it: its commits carry its own name, whatever the
    // checkout's git config says (named residents keep the identity their desk's checkout was set up with)
    ...(agent.forkOf ? gitIdentityEnv(agent.name) : {}),
  };
  Object.assign(env, grantedSecrets(ctx, session, building.id));
  const f = funding ?? fundingFor(world, agent.id, session.model);
  assertHostedCredential(f.credential, !!ctx.hosted || world.bank.hosted()); // a hosted collective's desk never gets a subscription token
  const auth = deskAuth(f);
  Object.assign(env, auth.env);
  env.DESK_AUTH = auth.mode; // a label, not a secret: the desk logs it
  console.log(`[runtime] ${agent.name} session ${session.id} auth: ${auth.mode}`);
  if (codeWorkspace(world.town.get(), building)) {
    const gh = opts.ghToken ? opts.ghToken() : repoToken(world, ctx.desks.ghToken);
    if (gh) env.GH_TOKEN = gh;
    else console.warn(`[runtime] ${agent.name} session ${session.id}: no GH_TOKEN for the desk (${noRepoTokenReason(ctx.desks.ghToken)}); cloning a private repo and pushing will fail`);
  }
  assertOneCredential(env); // the invariant, checked on the env that leaves the host: one credential, no failover key
  return env;
}

/** Git author and committer for `name` (as the desk's workspace setup writes into a checkout: `<slug>@muster-town.local`). */
function gitIdentityEnv(name: string): Record<string, string> {
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent"}@muster-town.local`;
  return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
}

/**
 * The GitHub token for the collective's repo (docs/secrets.md): the collective's `GH_TOKEN` secret at the Town Hall, else
 * the host's per `desks.ghToken` (`gh auth token`, the host env, or none). Desks with code access get it; the redeploy
 * pulls with it. null when neither has one. A secret: never log it.
 */
export function repoToken(world: World, mode: DesksConfig["ghToken"]): string | null {
  return world.secrets.value(REPO_TOKEN_SECRET) ?? (mode === "gh-cli" ? ghCliToken() : mode === "env" ? process.env.GH_TOKEN ?? null : null);
}

/** Why `repoToken` came back empty, for log lines. */
export function noRepoTokenReason(mode: DesksConfig["ghToken"]): string {
  const host = mode === "gh-cli" ? "desks.ghToken is gh-cli but `gh auth token` gave nothing on the host"
    : mode === "env" ? "desks.ghToken is env but GH_TOKEN is not set on the host"
    : "desks.ghToken is none";
  return `no GH_TOKEN secret at the Town Hall, and ${host}`;
}

/**
 * Env for the redeploy's git commands: the repo token as a credential helper, unless the host already configured one
 * (the Fly entrypoint does when it has a host GH_TOKEN). Empty when there is no token.
 */
export function gitAuthEnv(world: World, mode: DesksConfig["ghToken"], hostEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const token = repoToken(world, mode);
  if (!token) return {};
  const env: Record<string, string> = { GH_TOKEN: token };
  if (hostEnv.GIT_CONFIG_COUNT === undefined) {
    Object.assign(env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f' });
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
    if (handle.createdMs !== undefined) {
      // a new desk sandbox (Machine or container): its create time, the cost a warm desk slot avoids
      world.events.append({ type: "agent.activity", agentId, buildingId: building.id, text: `New desk ${handle.name} created in ${(handle.createdMs / 1000).toFixed(1)} s`, payload: { desk: handle.name, createdMs: handle.createdMs, forkOf: agent.forkOf ?? null } });
    }
    const funding = fundingForSession(world, agentId, assignmentId);
    const mode = funding.auth;
    session = world.ops.startSession(agentId, { purpose: "work", model: agent.model ?? building.model, assignmentId, backend: "docker", funding: mode, inputId: funding.inputId ?? null, credentialInputId: funding.credential.inputId, size: handle.size ?? null });
    if (handle.sizeFallback && handle.size) {
      // gr_uhh6u39vv9 step 3: past the town-wide desk bill cap a session still starts, on the cheaper size
      const bill = world.deskBill();
      world.events.append({ type: "system", agentId, buildingId: building.id, text: `Desk bill cap reached ($${bill.todayUsd.toFixed(2)} of $${bill.capUsd}/day): ${agent.name}'s session runs on ${deskPreset(handle.size)} instead`, payload: { deskBillCap: true, sessionId: session.id, size: handle.size, todayUsd: bill.todayUsd, capUsd: bill.capUsd } });
    }
    ctx.deskAllocations.set(session.id, funding.allocationId);
    world.events.append({ type: "agent.activity", agentId, buildingId: building.id, text: `Starting work (${fundedBy(mode)})`, payload: { sessionId: session.id, purpose: "work", backend: "docker", funding: mode } });
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
  if (input.kind === "usage") {
    // the desk's cumulative usage so far: booked now, on the allocation the session was handed (1:1 mt_x40qq8poc3 decision 2)
    if (input.usage) bookRunning(world, s.id, input.usage, ctx.deskAllocations.get(s.id) ?? null);
  } else if (input.kind === "tool") {
    const tool = input.tool ?? "tool";
    world.events.append({ type: "agent.tool", agentId, buildingId: bid, text: describeTool(world, tool, input.input), payload: { ...base, tool, input: clipJson(input.input), ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}) } });
    const live = ctx.live.get(agentId);
    if (live?.sessionId === s.id && tool === "mcp__town__submit_report") live.reportSubmitted = true;
  } else if (input.kind === "result") {
    if (input.toolUseId) world.toolResults.record(s.id, input.toolUseId, input.text ?? "", !!input.isError);
  } else if (input.kind === "rate-limit") {
    // the plan's word on this session's window (availability.ts), for the Bank input the session was handed
    if (input.rateLimit && s.credentialInputId) world.bank.availability.observeRateLimit(s.credentialInputId, input.rateLimit, s.id);
  } else if (input.kind === "thought") {
    const t = (input.text ?? "").trim();
    if (t) world.events.append({ type: "agent.thought", agentId, buildingId: bid, text: clipThought(t), payload: base });
  } else {
    const t = (input.text ?? "").trim();
    if (t) world.events.append({ type: "agent.activity", agentId, buildingId: bid, text: t.slice(0, 200), payload: base });
  }
}
