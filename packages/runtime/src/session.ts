/**
 * One agent session over the town MCP endpoint: start → stream SDK messages into events →
 * end + charge. Work/review/facilitation sessions all go through `runAgentSession`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DesksConfig } from "@muster-town/schema";
import { AppError, NO_KEY_HOLD, type World } from "@muster-town/core";
import { rawTokens, splitRaw, VERB_NAMES, type AllocationAuth, type Session, type VerbName } from "@muster-town/schema";
import { describeTool } from "./describe.ts";
import { blocksOf, hostApiKey, InputChannel, noUsage, sessionEnv, usageOf, type LooseMessage, type Options, type QueryHandle, type Sdk, type Usage } from "./sdk.ts";

export interface Ctx {
  world: World;
  mcpUrl: string;
  repoRoot: string;
  desks: DesksConfig;
  now: () => Date;
  sdk: Sdk;
  /** live work and manage sessions by agentId (host ones take interrupts directly; desk ones hold the exec child) */
  live: Map<string, LiveSession>;
  /** live facilitate sessions by agentId: the redeploy drain waits for them too (a restart mid-meeting orphans the facilitator) */
  facilitating: Map<string, LiveSession>;
  /** desk sessions' funding allocation, by sessionId (charged in finishWorkSession) */
  deskAllocations: Map<string, string | null>;
  /** desk sessions' fallback allocation (charged instead when the desk failed over to the API key), by sessionId */
  deskFallbacks: Map<string, string | null>;
  /** where host sessions' Agent SDK writes its JSONL (tests; a hosted runtime's own config dir); default $CLAUDE_CONFIG_DIR or ~/.claude */
  claudeDir?: string;
  /** the host env funding and sessions allowlist from (a hosted runtime's scrubbed `hostedEnv`); default process.env */
  env?: NodeJS.ProcessEnv;
  /** a hosted collective's runtime: sessions run on its own API key only, never the host's login (see `keyless`) */
  hosted?: boolean;
  /** register background work so tests (and stop()) can await it */
  track<T>(p: Promise<T>): Promise<T>;
}

export interface LiveSession {
  /** host = in-process SDK query (takes interrupts directly); desk = a child process in the agent's container */
  kind: "host" | "desk";
  agentId: string;
  sessionId: string;
  purpose: Session["purpose"];
  input: InputChannel;
  q: QueryHandle | null;
  reportSubmitted: boolean;
  stopped: boolean;
  /** desk sessions: the `docker exec` child */
  child?: { kill(): void };
  /** desk sessions the previous server left running at its redeploy restart: no child here; alive while the desk polls control */
  adopted?: boolean;
}

export const TOWN_TOOLS = VERB_NAMES.map((v) => `mcp__town__${v}`);
export const WEB_TOOLS = ["WebSearch", "WebFetch"];
export const DISALLOWED_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Task", "Agent"];
export const THOUGHT_CHARS = 200;
export const clipThought = (t: string) => (t.length > THOUGHT_CHARS ? t.slice(0, THOUGHT_CHARS - 1) + "…" : t);

export interface SessionSpec {
  agentId: string;
  purpose: Session["purpose"];
  model: string;
  system: string;
  prompt: string;
  maxTurns: number;
  web: boolean;
  assignmentId?: string | null;
  meetingId?: string | null;
  /** only these town verbs are allowed (the rest are disallowed outright); absent = every verb. Meeting replies: read, search, meeting. */
  verbs?: VerbName[];
  /** after a turn with no input pending, keep waiting for more input instead of ending (manage sessions with an open 1:1) */
  keepOpen?: () => boolean;
  /** work sessions: ends the session instead of the default endSession + charge (see finishWorkSession) */
  finish?: (out: SessionOutcome, allocationId: string | null) => Promise<Session>;
}
export interface SessionOutcome extends Usage {
  sdkSessionId: string | null;
  session: Session;
  finalText: string;
  error: string | null;
  reportSubmitted: boolean;
  stopped: boolean;
}

export const homeOf = (world: World, agentId: string) => {
  const a = world.agents.require(agentId, "agent");
  return a.homeBuildingId ?? a.buildingId;
};

/**
 * Charge usage to the agent and (if its building has budget) an allocation. Never throws. Booked in adjusted output
 * tokens (Bank step 3): the counters priced at `model`'s list price, per model with `byModel` (the session's own figure).
 */
export function chargeUsage(world: World, agentId: string, u: Pick<Usage, "tokens" | "counts" | "costUsd"> & { byModel?: Usage["byModel"] }, allocationId?: string | null, model?: string | null, grantId?: string | null): void {
  if (u.tokens <= 0 && u.costUsd <= 0) return;
  // the five counters when the SDK gave them; a bare raw total is split by the back-fill rule (docs/bank.md)
  const counts = rawTokens(u.counts) > 0 ? u.counts : splitRaw(u.tokens, model);
  const price = { model, byModel: rawTokens(u.counts) > 0 ? u.byModel : null, grantId: grantId ?? null };
  try {
    const bid = homeOf(world, agentId);
    // a member-funded grant's own input can pay even when the building's pool is empty
    const ownInput = grantId ? world.grants.get(grantId)?.fundedWith ?? null : null;
    if (bid && (world.budget.remaining(bid) > 0 || ownInput)) {
      world.budget.charge(agentId, counts, u.costUsd, allocationId ?? undefined, price);
    } else {
      // no allocation to draw from (e.g. Town Hall's librarian): record spend on the agent and in the usage ledger only
      world.budget.recordUsage(agentId, counts, u.costUsd, price);
    }
  } catch (e) {
    console.log("[runtime] charge failed:", e instanceof Error ? e.message : e);
  }
}

/** How a session is paid for. `auth` null: nothing funds it (no allocation, no Bank share); the env's own login is used. */
export interface Funding {
  allocationId: string | null;
  auth: AllocationAuth | null;
  /** the API key to run on (donor-key: the donor's; api-key: the input's or the env's ANTHROPIC_API_KEY); null for the subscription */
  apiKey: string | null;
  /** subscription sessions: the donor-key / api-key allocation a desk fails over to when the subscription hits its spend limit */
  fallback?: { allocationId: string | null; apiKey: string };
  /** member funding: the grant's own api-key input the session runs on (its key), when it has one */
  inputId?: string;
}

/**
 * Funding for an agent's next session, in order: the building's subscription allocations → its Bank share (today's
 * subscription share runs on the server's own login; the durable share on the oldest API-key input) → donor-key
 * allocations → api-key allocations. Retired allocations are never picked. A subscription funding carries a `fallback`
 * only when something in the Bank owns the key it would fail over to: a donor-key allocation's key, or the Bank's
 * api-key input's own key (`fallbackInput`). The host's `ANTHROPIC_API_KEY` is never a fallback and never a source
 * once the host has a subscription token (`hostApiKey`): an api-key share or allocation with no key of its own then
 * runs on the subscription and is recorded as such. Post-mortem 2026-10-30.
 */
export function fundingFor(world: World, agentId: string, env: NodeJS.ProcessEnv = process.env): Funding {
  const bid = homeOf(world, agentId);
  if (!bid) return { allocationId: null, auth: null, apiKey: null };
  const hostKey = hostApiKey(env);
  const onToken = !!env.CLAUDE_CODE_OAUTH_TOKEN;
  /** an api-key share or allocation: on its key when it has one, else the host's (no token), else the subscription */
  const keyed = (allocationId: string | null, key: string | null): Funding =>
    key ? { allocationId, auth: "api-key", apiKey: key } : { allocationId, auth: onToken ? "subscription" : "api-key", apiKey: null };
  const withFallback = (f: Funding): Funding => {
    if (f.auth !== "subscription") return f;
    const fb = world.budget.fallbackAllocation(bid);
    const input = world.bank.fallbackInput(bid);
    const key = (fb && world.budget.apiKeyFor(fb)) || (input && world.bank.apiKeyFor(input.id)) || null;
    return key ? { ...f, fallback: { allocationId: fb?.id ?? null, apiKey: key } } : f;
  };
  const sub = world.budget.pickAllocation(bid, ["subscription"]);
  if (sub) return withFallback({ allocationId: sub.id, auth: "subscription", apiKey: null });
  const bank = world.bank.fundingFor(bid);
  if (bank) {
    if (bank.kind === "expiring") return withFallback({ allocationId: null, auth: "subscription", apiKey: null });
    return keyed(null, (bank.inputId ? world.bank.apiKeyFor(bank.inputId) : null) ?? hostKey);
  }
  const alloc = world.budget.pickAllocation(bid);
  if (!alloc) return { allocationId: null, auth: null, apiKey: null };
  if (alloc.auth === "donor-key") return { allocationId: alloc.id, auth: "donor-key", apiKey: world.budget.apiKeyFor(alloc) };
  return alloc.auth === "subscription" ? withFallback({ allocationId: alloc.id, auth: "subscription", apiKey: null }) : keyed(alloc.id, hostKey);
}

/**
 * Funding for a session on an assignment: when the assignment's grant was funded from a member's own live api-key input
 * with a balance (`fundedWith`), the session runs on that input's key (the Bank debits that input first, see
 * Bank.drawFromInput). Otherwise, or without an assignment, the building's choice (`fundingFor`).
 */
export function fundingForSession(world: World, agentId: string, assignmentId: string | null | undefined, env: NodeJS.ProcessEnv = process.env): Funding {
  const asg = assignmentId ? world.assignments.get(assignmentId) : undefined;
  const input = asg?.grantId && homeOf(world, agentId) ? world.bank.grantKeyInput(world.grants.get(asg.grantId)) : null;
  const key = input ? world.bank.apiKeyFor(input.id) : null;
  if (input && key) return { allocationId: null, auth: "api-key", apiKey: key, inputId: input.id };
  return fundingFor(world, agentId, env);
}

/** A hosted runtime's funding with no API key of its own: the call is refused (held, "No key yet"), never run on another login. */
export const keyless = (ctx: Ctx, f: Pick<Funding, "apiKey">): boolean => !!ctx.hosted && !f.apiKey;

/** "funded by subscription" / "funded by API key" / "funded by a donor's API key", for status lines. */
export function fundedBy(auth: AllocationAuth | null | undefined): string {
  return auth === "subscription" ? "funded by subscription" : auth === "donor-key" ? "funded by a donor's API key" : auth === "api-key" ? "funded by API key" : "unfunded";
}

export function townOptions(ctx: Ctx, spec: SessionSpec, apiKey: string | null): Options {
  const token = ctx.world.tokens.getOrCreate("agent", spec.agentId);
  const townTools = spec.verbs ? spec.verbs.map((v) => `mcp__town__${v}`) : TOWN_TOOLS;
  return {
    model: spec.model,
    maxTurns: spec.maxTurns,
    systemPrompt: { type: "preset", preset: "claude_code", append: spec.system },
    mcpServers: { town: { type: "http", url: ctx.mcpUrl, headers: { Authorization: `Bearer ${token}` }, alwaysLoad: true } },
    // `tools` is the built-in tool set available to the session; `allowedTools` only auto-approves within it.
    // In-process sessions never get code tools: code work happens in desks (docker backend).
    tools: spec.web ? WEB_TOOLS : [],
    allowedTools: [...townTools, ...(spec.web ? WEB_TOOLS : [])],
    disallowedTools: [...DISALLOWED_TOOLS, ...(spec.web ? [] : WEB_TOOLS), ...TOWN_TOOLS.filter((t) => !townTools.includes(t))],
    settingSources: [],
    env: sessionEnv(apiKey, ctx.env),
  };
}

export const clipJson = (v: unknown, n = 500) => {
  try { const s = JSON.stringify(v); return s.length > n ? s.slice(0, n) + "…" : s; } catch { return ""; }
};

/** The SDK's JSONL for `sdkSessionId` under `<claudeDir>/projects/<cwd slug>/`, or null. */
export function findSdkTranscript(claudeDir: string, sdkSessionId: string): Buffer | null {
  const root = join(claudeDir, "projects");
  if (!existsSync(root)) return null;
  for (const d of readdirSync(root)) {
    const f = join(root, d, `${sdkSessionId}.jsonl`);
    if (existsSync(f)) return readFileSync(f);
  }
  return null;
}

/** Keep a host session's transcript in the town (docs/transcripts.md). Best effort: a failure is logged, never thrown. */
export function keepHostTranscript(ctx: Ctx, session: Session, sdkSessionId: string | null): void {
  if (!sdkSessionId) return;
  try {
    const raw = findSdkTranscript(ctx.claudeDir ?? (process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")), sdkSessionId);
    if (raw?.length) ctx.world.transcripts.put(session, raw, { compressed: false, source: "host" });
  } catch (e) {
    ctx.world.events.append({ type: "system", agentId: session.agentId, text: `Transcript for session ${session.id} not kept: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300), payload: { transcript: false, sessionId: session.id } });
  }
}

export async function runAgentSession(ctx: Ctx, spec: SessionSpec): Promise<SessionOutcome> {
  const { world } = ctx;
  const agent = world.agents.require(spec.agentId, "agent");
  const bid = homeOf(world, agent.id);
  const funding = fundingForSession(world, agent.id, spec.assignmentId, ctx.env);
  if (keyless(ctx, funding)) throw new AppError("conflict", `${agent.name} is held: ${NO_KEY_HOLD}`);
  const session = world.ops.startSession(agent.id, { purpose: spec.purpose, model: spec.model, assignmentId: spec.assignmentId ?? null, meetingId: spec.meetingId ?? null, backend: "host", funding: funding.auth, inputId: funding.inputId ?? null });
  const live: LiveSession = { kind: "host", agentId: agent.id, sessionId: session.id, purpose: spec.purpose, input: new InputChannel(), q: null, reportSubmitted: false, stopped: false };
  // work and manage sessions take interrupts and count as the agent's live session (scheduler, redeploy drain, abort)
  if (spec.purpose === "work" || spec.purpose === "manage") ctx.live.set(agent.id, live);
  else if (spec.purpose === "facilitate") ctx.facilitating.set(agent.id, live);
  const emit = (type: "agent.tool" | "agent.thought" | "system", text: string, payload: Record<string, unknown> = {}) =>
    world.events.append({ type, agentId: agent.id, buildingId: bid, text, payload: { sessionId: session.id, purpose: spec.purpose, ...payload } });

  let usage: Usage = noUsage();
  let finalText = "";
  let error: string | null = null;
  let sdkSessionId: string | null = null;
  let toolsAfterReport = 0;
  live.input.push(spec.prompt);
  if (spec.purpose === "work") {
    // interrupts queued while the agent had no in-process session arrive right after the prompt
    const queued = world.ops.pendingInterrupts(agent.id, session.id);
    for (const it of queued) live.input.push(`Interrupt from ${it.from}: ${it.text}\n\nTake this into account now, then continue. You must still finish with submit_report.`);
    if (queued.length) world.ops.ackInterrupts(queued.map((i) => i.id));
  }
  try {
    const q = ctx.sdk.query({ prompt: live.input, options: townOptions(ctx, spec, funding.apiKey) });
    live.q = q;
    for await (const raw of q) {
      const m = raw as LooseMessage;
      if (m.session_id && !sdkSessionId) sdkSessionId = m.session_id;
      if (m.type === "assistant") {
        for (const b of blocksOf(m)) {
          if (b.type === "tool_use" && b.name) {
            emit("agent.tool", describeTool(world, b.name, b.input), { tool: b.name, input: clipJson(b.input) });
            if (live.reportSubmitted && ++toolsAfterReport > 2) void q.interrupt?.().catch(() => undefined);
          } else if (b.type === "text" && b.text?.trim()) {
            const t = b.text.trim();
            finalText = t;
            emit("agent.thought", clipThought(t));
          }
        }
      } else if (m.type === "result") {
        usage = usageOf(m);
        if (typeof m.result === "string" && m.result.trim()) finalText = m.result.trim();
        // a later turn that succeeds clears an earlier turn's error (e.g. one aborted by an interrupt-now)
        error = m.is_error ? m.errors?.join("; ") || m.subtype || "session ended with an error" : null;
        // streaming input: one result per turn. Finish unless an interrupt is queued or the spec keeps it open for more.
        if (live.stopped || live.reportSubmitted || (live.input.pending === 0 && !(m.queued_turn_count && m.queued_turn_count > 0) && !spec.keepOpen?.())) {
          live.input.close();
          break;
        }
      }
      if (!live.reportSubmitted && world.sessions.get(session.id)?.reportId) {
        live.reportSubmitted = true;
        live.input.close(); // the runtime ends the session after submit_report
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    live.input.close();
    if (ctx.live.get(agent.id) === live) ctx.live.delete(agent.id);
    if (ctx.facilitating.get(agent.id) === live) ctx.facilitating.delete(agent.id);
  }
  if (!live.reportSubmitted && world.sessions.get(session.id)?.reportId) live.reportSubmitted = true;

  keepHostTranscript(ctx, session, sdkSessionId);
  const outcome: SessionOutcome = { ...usage, sdkSessionId, session, finalText, error, reportSubmitted: live.reportSubmitted, stopped: live.stopped };
  if (spec.finish) {
    outcome.session = await spec.finish(outcome, funding.allocationId);
    return outcome;
  }
  const status: Exclude<Session["status"], "running"> = live.stopped ? "interrupted" : error ? "error" : "done";
  outcome.session = world.ops.endSession(session.id, { status, counts: usage.counts, byModel: usage.byModel, costUsd: usage.costUsd, turns: usage.turns, error, sdkSessionId });
  chargeUsage(world, agent.id, usage, funding.allocationId, outcome.session.model, outcome.session.grantId);
  return outcome;
}
