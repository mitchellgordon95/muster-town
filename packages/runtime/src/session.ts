/**
 * One agent session over the town MCP endpoint: start → stream SDK messages into events →
 * end + charge. Work/review/facilitation sessions all go through `runAgentSession`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DesksConfig } from "@muster-town/schema";
import { sessionTokens, AppError, booked, NoCredential, resultLine, type Booked, type Credential, type Funding, type World } from "@muster-town/core";
import { countsOf, mergeUsage, rawTokens, splitRaw, subTokens, UsageMeter, VERB_NAMES, ZERO_TOKENS, type AllocationAuth, type Session, type TokenUsage, type VerbName } from "@muster-town/schema";
import { CODE_TOOLS, codeGuard, type CodeCheckout, type CodeSource } from "./code.ts";
import { describeTool } from "./describe.ts";
import { assertNoEnvCredentials, blocksOf, InputChannel, noUsage, sessionEnv, usageOf, type LooseMessage, type Options, type QueryHandle, type Sdk, type Usage } from "./sdk.ts";

export interface Ctx {
  world: World;
  mcpUrl: string;
  repoRoot: string;
  desks: DesksConfig;
  now: () => Date;
  sdk: Sdk;
  /** live work and manage sessions by agentId (host ones take interrupts directly; desk ones hold the exec child) */
  live: Map<string, LiveSession>;
  /** host conversation sessions (a human's 1:1) running alongside the agent's live work session, by agentId: one per agent */
  talking: Map<string, LiveSession>;
  /** live facilitate sessions by agentId: the redeploy drain waits for them too (a restart mid-meeting orphans the facilitator) */
  facilitating: Map<string, LiveSession>;
  /** desk sessions' funding allocation, by sessionId (charged in finishWorkSession) */
  deskAllocations: Map<string, string | null>;
  /** how often a running session's usage is booked (bookRunning), in ms; default USAGE_BOOK_MS (tests: 0 = every message) */
  usageBookMs?: number;
  /** where host sessions' Agent SDK writes its JSONL (tests; a hosted runtime's own config dir); default $CLAUDE_CONFIG_DIR or ~/.claude */
  claudeDir?: string;
  /** the host env funding and sessions allowlist from (a hosted runtime's scrubbed `hostedEnv`); default process.env */
  env?: NodeJS.ProcessEnv;
  /** a hosted collective's runtime: its own Bank only (no subscription inputs), in a scrubbed env (`hostedEnv`) */
  hosted?: boolean;
  /** the read-only snapshot of main manage sessions read (code.ts); absent = no code tools */
  code?: CodeSource;
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
  /** host sessions: between turns, waiting on its input (a pushed message starts the next turn; no need to cut one short) */
  idle?: boolean;
}

export const TOWN_TOOLS = VERB_NAMES.map((v) => `mcp__town__${v}`);
export const WEB_TOOLS = ["WebSearch", "WebFetch"];
export const DISALLOWED_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Task", "Agent"];
const THOUGHT_CHARS = 200;
export const clipThought = (t: string) => (t.length > THOUGHT_CHARS ? t.slice(0, THOUGHT_CHARS - 1) + "…" : t);

interface SessionSpec {
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
  /** a conversation running alongside the agent's live work session: registered in `ctx.talking`, not `ctx.live` */
  alongside?: boolean;
  /** read the town's code: Read, Grep and Glob over this snapshot (its dir is the cwd; a guard denies paths outside it) */
  code?: CodeCheckout | null;
  /** continue this SDK session (its JSONL under the claude dir) instead of starting a new one: a team-lead session cut by a restart (manage.ts `resumableManage`) */
  resume?: string | null;
  /** work sessions: ends the session instead of the default endSession + charge (see finishWorkSession) */
  finish?: (out: SessionOutcome, allocationId: string | null) => Promise<Session>;
}
interface SessionOutcome extends Usage {
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
 * Charge usage to the agent and its home building. Never throws. Booked in adjusted output tokens (Bank step 3): the
 * counters priced at `model`'s list price, per model with `byModel` (the session's own figure).
 */
export function chargeUsage(world: World, agentId: string, u: Pick<Usage, "tokens" | "counts" | "costUsd"> & { byModel?: Usage["byModel"] }, allocationId?: string | null, model?: string | null, grantId?: string | null): void {
  // the five counters when the SDK gave them; a bare raw total is split by the back-fill rule (docs/bank.md)
  const real = rawTokens(u.counts) > 0;
  const counts = real ? u.counts : splitRaw(u.tokens, model);
  chargeBooked(world, agentId, booked(counts, model, real ? u.byModel : null), u.costUsd, allocationId, grantId);
}

/**
 * Debit an already booked amount (adjusted output tokens + counters) to the agent's home building. Every token is
 * debited (1:1 mt_x40qq8poc3 decision 2): a building with nothing left overshoots its last source (Budget.charge, no
 * hard stop) instead of the usage going unbooked (the Spending tab's "Not funded"). The Town Hall draws like any
 * building (1:1 mt_cz11aqe81a). Only an agent with no building is recorded on the agent and the usage ledger alone.
 * Never throws.
 */
function chargeBooked(world: World, agentId: string, b: Booked, usd: number, allocationId?: string | null, grantId?: string | null, inputId?: string | null): void {
  if (b.tokens <= 0 && rawTokens(b.counts) <= 0 && usd <= 0) return;
  try {
    debit(world, agentId, b, usd, allocationId, grantId, false, inputId);
  } catch (e) {
    console.log("[runtime] charge failed:", e instanceof Error ? e.message : e);
  }
}

function debit(world: World, agentId: string, b: Booked, usd: number, allocationId?: string | null, grantId?: string | null, running = false, inputId?: string | null): void {
  const bid = homeOf(world, agentId);
  if (!bid) world.budget.recordUsage(agentId, b, usd);
  else world.budget.charge(agentId, b, usd, allocationId ?? undefined, { grantId: grantId ?? null, inputId: inputId ?? null, running });
}

/** How often a running session's usage is booked (host loop and desk posts): once a minute. */
const USAGE_BOOK_MS = 60_000;

/** What the Bank has booked for a session so far: its row's counters, written as it runs and at its end. */
const bookedOf = (s: Session): TokenUsage => ({ counts: countsOf(s), byModel: s.byModel ?? {} });

/**
 * Bring a session's row up to `seen` (mergeUsage: never below what it already booked) and return the difference, the
 * part still to debit, in adjusted output tokens. The row and the Bank's debits move together, so however a session
 * ends (report, error, spend limit, kill, lost desk, restart) its debits add up to its row: the running bookings plus
 * the final true-up.
 */
function settleUsage(world: World, sessionId: string, seen: TokenUsage | null): Booked {
  const s = world.sessions.require(sessionId, "session");
  const before = bookedOf(s);
  if (!seen) return { tokens: 0, counts: { ...ZERO_TOKENS } };
  const after = mergeUsage(before, seen);
  const byModel = Object.keys(after.byModel).length ? after.byModel : null;
  world.sessions.patch(s.id, { ...after.counts, byModel });
  const tokens = sessionTokens({ ...s, ...after.counts, byModel }) - sessionTokens(s);
  return { tokens: Math.max(0, tokens), counts: subTokens(after.counts, before.counts) };
}

/**
 * Book a running session's usage so far (1:1 mt_x40qq8poc3 decision 2): the row moves up to `seen` and the difference
 * is debited at once, in one transaction, so the Bank's next credential pick (Budget.fundingFor) sees the real balance.
 * The out-of-budget check waits for the session's end. A session that already ended is left alone. Never throws.
 */
export function bookRunning(world: World, sessionId: string, seen: TokenUsage, allocationId: string | null): Booked | null {
  try {
    return world.transaction(() => {
      const s = world.sessions.get(sessionId);
      if (!s || s.status !== "running") return null;
      const d = settleUsage(world, sessionId, seen);
      if (d.tokens > 0 || rawTokens(d.counts) > 0) debit(world, s.agentId, d, 0, allocationId, s.grantId, true, s.credentialInputId);
      return d;
    });
  } catch (e) {
    console.log("[runtime] running booking failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * End a session and debit what its running bookings haven't: the row is settled to `usage` (settleUsage), ended
 * (ops.endSession keeps the settled counters), then the rest is charged with the session's whole cost.
 */
export function endAndCharge(world: World, sessionId: string, usage: Pick<Usage, "counts" | "byModel" | "costUsd" | "turns">, end: Omit<Parameters<World["ops"]["endSession"]>[1], "counts" | "byModel" | "tokens" | "costUsd" | "turns">, allocationId: string | null | undefined): Session {
  const rest = settleUsage(world, sessionId, { counts: usage.counts, byModel: usage.byModel ?? {} });
  const settled = world.sessions.require(sessionId, "session");
  // the settled per-model split rides on session.ended like before (endSession keeps the row's counters)
  const byModel = settled.byModel && Object.keys(settled.byModel).length ? { byModel: settled.byModel } : {};
  const ended = world.ops.endSession(sessionId, { ...end, ...byModel, costUsd: usage.costUsd, turns: usage.turns });
  chargeBooked(world, ended.agentId, rest, usage.costUsd, allocationId, ended.grantId, ended.credentialInputId);
  return ended;
}

/** A session's final usage: the result message's when it covers what the meter saw, else the meter's (mergeUsage). */
function finalUsage(meter: UsageMeter, u: Usage): Usage {
  const m = mergeUsage(meter.usage(), u);
  return { ...u, tokens: rawTokens(m.counts), counts: m.counts, byModel: m.byModel };
}

export type { Funding };

/**
 * Funding for an agent's next session: the Bank's one answer (`Budget.fundingFor`) for the agent's building. The host
 * env is never consulted; the Bank holding nothing that can run it throws `NoCredential` (post-mortem 2026-10-30).
 */
export function fundingFor(world: World, agentId: string, model?: string | null): Funding {
  const bid = homeOf(world, agentId);
  if (!bid) throw new NoCredential(`${world.nameOf(agentId)} has no building to be funded through`);
  return world.budget.fundingFor(bid, { model: model ?? world.budget.sessionModel(agentId) });
}


/**
 * Funding for a session on an assignment, in the draw order (goal tree step 7): when the assignment's grant was funded
 * from a member's own live api-key input with a balance (`fundedWith`), that input's key; else the nearest earmark above
 * the work's goal that covers a whole session (`Streams.pick`), on its key; else the building's choice (`fundingFor`).
 * The input it ran on pays first when the session is charged (Bank.drawFromStream).
 */
export function fundingForSession(world: World, agentId: string, assignmentId: string | null | undefined): Funding {
  const bid = homeOf(world, agentId);
  if (!bid) throw new NoCredential(`${world.nameOf(agentId)} has no building to be funded through`);
  const asg = assignmentId ? world.assignments.get(assignmentId) : undefined;
  const grant = asg?.grantId ? world.grants.get(asg.grantId) ?? null : null;
  // the model the session runs on: availability is per model, and a limited credential is never swapped for another model
  return world.budget.fundingFor(bid, { grant, stream: world.streams.pick(asg, bid), model: world.budget.sessionModel(agentId, asg) });
}

/** "funded by subscription" / "funded by API key" / "funded by a donor's API key", for status lines. */
export function fundedBy(auth: AllocationAuth | null | undefined): string {
  return auth === "subscription" ? "funded by subscription" : auth === "donor-key" ? "funded by a donor's API key" : auth === "api-key" ? "funded by API key" : "unfunded";
}

export function townOptions(ctx: Ctx, spec: SessionSpec, credential: Credential, sessionId?: string): Options {
  // the session's own token, revoked when it ends (docs/secrets.md "Login tokens")
  const token = sessionId ? ctx.world.tokens.createForSession(spec.agentId, sessionId) : ctx.world.tokens.getOrCreate("agent", spec.agentId);
  const townTools = spec.verbs ? spec.verbs.map((v) => `mcp__town__${v}`) : TOWN_TOOLS;
  const readTools: string[] = spec.code ? [...CODE_TOOLS] : [];
  return {
    model: spec.model,
    maxTurns: spec.maxTurns,
    systemPrompt: { type: "preset", preset: "claude_code", append: spec.system },
    mcpServers: { town: { type: "http", url: ctx.mcpUrl, headers: { Authorization: `Bearer ${token}` }, alwaysLoad: true } },
    // `tools` is the built-in tool set available to the session; `allowedTools` only auto-approves within it.
    // In-process sessions never edit or run code (that happens in desks); a manage session may read it (code.ts).
    tools: [...(spec.web ? WEB_TOOLS : []), ...readTools],
    allowedTools: [...townTools, ...(spec.web ? WEB_TOOLS : []), ...readTools],
    disallowedTools: [...DISALLOWED_TOOLS.filter((t) => !readTools.includes(t)), ...(spec.web ? [] : WEB_TOOLS), ...TOWN_TOOLS.filter((t) => !townTools.includes(t))],
    settingSources: [],
    env: sessionEnv(credential, ctx.env, !!ctx.hosted || !!ctx.world?.host?.hosted),
    ...(spec.code ? { cwd: spec.code.dir, hooks: { PreToolUse: codeGuard(spec.code.dir) } } : {}),
    ...(spec.resume ? { resume: spec.resume } : {}),
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

/** Where host sessions' SDK transcripts live: the hosted collective's CLAUDE_CONFIG_DIR, else the server's. */
export const claudeDirOf = (ctx: Ctx): string => ctx.claudeDir ?? (process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));

/** Keep a host session's transcript in the town (docs/transcripts.md). Best effort: a failure is logged, never thrown. */
function keepHostTranscript(ctx: Ctx, session: Session, sdkSessionId: string | null): void {
  if (!sdkSessionId) return;
  try {
    const raw = findSdkTranscript(claudeDirOf(ctx), sdkSessionId);
    if (raw?.length) ctx.world.transcripts.put(session, raw, { compressed: false, source: "host" });
  } catch (e) {
    ctx.world.events.append({ type: "system", agentId: session.agentId, text: `Transcript for session ${session.id} not kept: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300), payload: { transcript: false, sessionId: session.id } });
  }
}

export async function runAgentSession(ctx: Ctx, spec: SessionSpec): Promise<SessionOutcome> {
  const { world } = ctx;
  const agent = world.agents.require(spec.agentId, "agent");
  const bid = homeOf(world, agent.id);
  const funding = fundingForSession(world, agent.id, spec.assignmentId);
  assertNoEnvCredentials(ctx.env); // a credential in the host env is a second auth source: refuse before a session row exists
  const session = world.ops.startSession(agent.id, { purpose: spec.purpose, model: spec.model, assignmentId: spec.assignmentId ?? null, meetingId: spec.meetingId ?? null, backend: "host", funding: funding.auth, inputId: funding.inputId ?? null, credentialInputId: funding.credential.inputId });
  const live: LiveSession = { kind: "host", agentId: agent.id, sessionId: session.id, purpose: spec.purpose, input: new InputChannel(), q: null, reportSubmitted: false, stopped: false };
  // work and manage sessions take interrupts and count as the agent's live session (scheduler, redeploy drain, abort)
  // (a 1:1 alongside a work session is the agent's conversation: `ctx.talking`, so it never holds the work lock)
  if (spec.alongside) ctx.talking.set(agent.id, live);
  else if (spec.purpose === "work" || spec.purpose === "manage") ctx.live.set(agent.id, live);
  else if (spec.purpose === "facilitate") ctx.facilitating.set(agent.id, live);
  const emit = (type: "agent.tool" | "agent.thought" | "system", text: string, payload: Record<string, unknown> = {}) =>
    world.events.append({ type, agentId: agent.id, buildingId: bid, text, payload: { sessionId: session.id, purpose: spec.purpose, ...payload } });

  let usage: Usage = noUsage();
  let finalText = "";
  let error: string | null = null;
  let sdkSessionId: string | null = null;
  let toolsAfterReport = 0;
  // debit as the session runs (1:1 mt_x40qq8poc3 decision 2): the meter's reading is booked at most every usageBookMs
  const meter = new UsageMeter();
  const bookMs = ctx.usageBookMs ?? USAGE_BOOK_MS;
  let bookedAt = Date.now();
  live.input.push(spec.prompt);
  if (spec.purpose === "work") {
    // interrupts queued while the agent had no in-process session arrive right after the prompt
    const queued = world.ops.pendingInterrupts(agent.id, session.id);
    for (const it of queued) live.input.push(`Interrupt from ${it.from}: ${it.text}\n\nTake this into account now, then continue. You must still finish with submit_report.`);
    if (queued.length) world.ops.ackInterrupts(queued.map((i) => i.id));
  }
  try {
    const q = ctx.sdk.query({ prompt: live.input, options: townOptions(ctx, spec, funding.credential, session.id) });
    live.q = q;
    for await (const raw of q) {
      const m = raw as LooseMessage;
      if (m.session_id && !sdkSessionId) {
        sdkSessionId = m.session_id;
        // on the row now, not only at the end: a restart that cuts the session leaves it there to resume from
        try { world.sessions.patch(session.id, { sdkSessionId }); } catch (e) { console.log("[runtime] sdkSessionId:", e instanceof Error ? e.message : e); }
      }
      if (meter.observe(m) && Date.now() - bookedAt >= bookMs) {
        bookedAt = Date.now();
        bookRunning(world, session.id, meter.usage(), funding.allocationId);
      }
      if (m.type === "assistant") {
        live.idle = false;
        for (const b of blocksOf(m)) {
          if (b.type === "tool_use" && b.name) {
            emit("agent.tool", describeTool(world, b.name, b.input), { tool: b.name, input: clipJson(b.input), ...(b.id ? { toolUseId: b.id } : {}) });
            if (live.reportSubmitted && ++toolsAfterReport > 2) void q.interrupt?.().catch(() => undefined);
          } else if (b.type === "text" && b.text?.trim()) {
            const t = b.text.trim();
            finalText = t;
            emit("agent.thought", clipThought(t));
          }
        }
      } else if (m.type === "rate_limit_event") {
        // the plan's own word on the window this session runs in (availability.ts): rejected records a limit with its
        // reset, allowed clears one. Only for a Bank input the session ran on.
        const info = (m as { rate_limit_info?: { status?: string; resetsAt?: number; rateLimitType?: string } }).rate_limit_info;
        if (info && funding.credential.inputId) {
          try { world.bank.availability.observeRateLimit(funding.credential.inputId, info, session.id); }
          catch (e) { console.warn(`[runtime] rate_limit_event: ${e instanceof Error ? e.message : e}`); }
        }
      } else if (m.type === "user") {
        // each call's outcome, one line, for the manager's `fork_status`
        for (const b of blocksOf(m)) if (b.type === "tool_result" && b.tool_use_id) world.toolResults.record(session.id, b.tool_use_id, resultLine(b.content), !!b.is_error);
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
        live.idle = live.input.pending === 0;
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
    if (ctx.talking.get(agent.id) === live) ctx.talking.delete(agent.id);
    if (ctx.facilitating.get(agent.id) === live) ctx.facilitating.delete(agent.id);
  }
  if (!live.reportSubmitted && world.sessions.get(session.id)?.reportId) live.reportSubmitted = true;

  keepHostTranscript(ctx, session, sdkSessionId);
  // a session that died before its result (or mid-turn) still counts every call the meter saw
  usage = finalUsage(meter, usage);
  const outcome: SessionOutcome = { ...usage, sdkSessionId, session, finalText, error, reportSubmitted: live.reportSubmitted, stopped: live.stopped };
  if (spec.finish) {
    outcome.session = await spec.finish(outcome, funding.allocationId);
    return outcome;
  }
  const status: Exclude<Session["status"], "running"> = live.stopped ? "interrupted" : error ? "error" : "done";
  outcome.session = endAndCharge(world, session.id, usage, { status, error, sdkSessionId }, funding.allocationId);
  return outcome;
}
