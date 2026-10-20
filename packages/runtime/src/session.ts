/**
 * One agent session over the town MCP endpoint: start → stream SDK messages into events →
 * end + charge. Work/review/facilitation sessions all go through `runAgentSession`.
 */
import type { World } from "@agent-town/core";
import { VERB_NAMES, type Session } from "@agent-town/schema";
import { describeTool } from "./describe.ts";
import { blocksOf, InputChannel, sessionEnv, usageOf, type LooseMessage, type Options, type QueryHandle, type Sdk, type Usage } from "./sdk.ts";

export interface Ctx {
  world: World;
  mcpUrl: string;
  repoRoot: string;
  now: () => Date;
  sdk: Sdk;
  /** live work sessions by agentId (these take interrupts) */
  live: Map<string, LiveSession>;
  /** register background work so tests (and stop()) can await it */
  track<T>(p: Promise<T>): Promise<T>;
}

export interface LiveSession {
  agentId: string;
  sessionId: string;
  purpose: Session["purpose"];
  input: InputChannel;
  q: QueryHandle | null;
  reportSubmitted: boolean;
  stopped: boolean;
}

export const TOWN_TOOLS = VERB_NAMES.map((v) => `mcp__town__${v}`);
export const WEB_TOOLS = ["WebSearch", "WebFetch"];
export const DISALLOWED_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Task", "Agent"];
const THOUGHT_CHARS = 200;

/** Base tool names a workspace needs enabled: "Bash(git:*)" → "Bash", "Edit" → "Edit". */
function workspaceBaseTools(ws: SessionWorkspace | undefined): string[] {
  if (!ws) return [];
  return [...new Set(ws.tools.map((p) => p.replace(/\(.*$/, "")))];
}

/** A workspace pattern like "Bash(git:*)" unlocks the "Bash" tool; a bare "Edit" unlocks Edit. */
function workspaceAllows(ws: SessionWorkspace | undefined, tool: string): boolean {
  if (!ws) return false;
  return ws.tools.some((p) => p === tool || p.startsWith(`${tool}(`));
}

export interface SessionWorkspace {
  /** per-agent git worktree the session runs in */
  cwd: string;
  branch: string;
  /** Claude Code tool permission patterns (e.g. "Edit", "Bash(git:*)") */
  tools: string[];
}

export interface SessionSpec {
  agentId: string;
  workspace?: SessionWorkspace;
  purpose: Session["purpose"];
  model: string;
  system: string;
  prompt: string;
  maxTurns: number;
  web: boolean;
  assignmentId?: string | null;
  meetingId?: string | null;
  /** runs after the SDK stream ends and before `endSession` (e.g. fallback report) */
  beforeEnd?: (out: SessionOutcome) => void | Promise<void>;
}
export interface SessionOutcome extends Usage {
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

/** Charge usage to the agent and (if its building has budget) an allocation. Never throws. */
export function chargeUsage(world: World, agentId: string, u: Usage, allocationId?: string | null): void {
  if (u.tokens <= 0 && u.costUsd <= 0) return;
  try {
    const bid = homeOf(world, agentId);
    if (bid && world.budget.remaining(bid) > 0) {
      world.budget.charge(agentId, u.tokens, u.costUsd, allocationId ?? undefined);
    } else {
      // no allocation to draw from (e.g. Town Hall's librarian): record spend on the agent only
      const a = world.agents.require(agentId, "agent");
      world.agents.patch(agentId, { spentTokensToday: a.spentTokensToday + Math.round(u.tokens), spentTokensTotal: a.spentTokensTotal + Math.round(u.tokens), spentUsdTotal: a.spentUsdTotal + u.costUsd });
    }
  } catch (e) {
    console.log("[runtime] charge failed:", e instanceof Error ? e.message : e);
  }
}

/** Allocation + donor API key for an agent's next session. */
export function fundingFor(world: World, agentId: string): { allocationId: string | null; apiKey: string | null } {
  const bid = homeOf(world, agentId);
  const alloc = bid ? world.budget.pickAllocation(bid) : null;
  return { allocationId: alloc?.id ?? null, apiKey: alloc ? world.budget.apiKeyFor(alloc) : null };
}

export function townOptions(ctx: Ctx, spec: SessionSpec, apiKey: string | null): Options {
  const token = ctx.world.tokens.getOrCreate("agent", spec.agentId);
  return {
    model: spec.model,
    maxTurns: spec.maxTurns,
    systemPrompt: { type: "preset", preset: "claude_code", append: spec.system },
    mcpServers: { town: { type: "http", url: ctx.mcpUrl, headers: { Authorization: `Bearer ${token}` }, alwaysLoad: true } },
    // `tools` is the built-in tool set available to the session; `allowedTools` only auto-approves within it.
    tools: [...(spec.web ? WEB_TOOLS : []), ...workspaceBaseTools(spec.workspace)],
    allowedTools: [...TOWN_TOOLS, ...(spec.web ? WEB_TOOLS : []), ...(spec.workspace?.tools ?? [])],
    disallowedTools: [...DISALLOWED_TOOLS.filter((t) => !workspaceAllows(spec.workspace, t)), ...(spec.web ? [] : WEB_TOOLS)],
    settingSources: [],
    env: sessionEnv(apiKey),
    ...(spec.workspace ? { cwd: spec.workspace.cwd } : {}),
  };
}

const clipJson = (v: unknown, n = 500) => {
  try { const s = JSON.stringify(v); return s.length > n ? s.slice(0, n) + "…" : s; } catch { return ""; }
};

export async function runAgentSession(ctx: Ctx, spec: SessionSpec): Promise<SessionOutcome> {
  const { world } = ctx;
  const agent = world.agents.require(spec.agentId, "agent");
  const bid = homeOf(world, agent.id);
  const funding = fundingFor(world, agent.id);
  const session = world.ops.startSession(agent.id, { purpose: spec.purpose, model: spec.model, assignmentId: spec.assignmentId ?? null, meetingId: spec.meetingId ?? null });
  const live: LiveSession = { agentId: agent.id, sessionId: session.id, purpose: spec.purpose, input: new InputChannel(), q: null, reportSubmitted: false, stopped: false };
  if (spec.purpose === "work") ctx.live.set(agent.id, live);
  const emit = (type: "agent.tool" | "agent.thought" | "system", text: string, payload: Record<string, unknown> = {}) =>
    world.events.append({ type, agentId: agent.id, buildingId: bid, text, payload: { sessionId: session.id, purpose: spec.purpose, ...payload } });

  let usage: Usage = { tokens: 0, costUsd: 0, turns: 0 };
  let finalText = "";
  let error: string | null = null;
  let sdkSessionId: string | null = null;
  let toolsAfterReport = 0;
  live.input.push(spec.prompt);
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
            emit("agent.thought", t.length > THOUGHT_CHARS ? t.slice(0, THOUGHT_CHARS - 1) + "…" : t);
          }
        }
      } else if (m.type === "result") {
        usage = usageOf(m);
        if (typeof m.result === "string" && m.result.trim()) finalText = m.result.trim();
        if (m.is_error) error = m.errors?.join("; ") || m.subtype || "session ended with an error";
        // streaming input: one result per turn. Finish unless an interrupt is queued.
        if (live.stopped || live.reportSubmitted || (live.input.pending === 0 && !(m.queued_turn_count && m.queued_turn_count > 0))) {
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
  }
  if (!live.reportSubmitted && world.sessions.get(session.id)?.reportId) live.reportSubmitted = true;

  const outcome: SessionOutcome = { ...usage, session, finalText, error, reportSubmitted: live.reportSubmitted, stopped: live.stopped };
  try {
    await spec.beforeEnd?.(outcome);
  } catch (e) {
    emit("system", `Runtime error after session: ${e instanceof Error ? e.message : String(e)}`);
  }
  const status: Exclude<Session["status"], "running"> = live.stopped ? "interrupted" : error ? "error" : "done";
  outcome.session = world.ops.endSession(session.id, { status, tokens: usage.tokens, costUsd: usage.costUsd, turns: usage.turns, error, sdkSessionId });
  chargeUsage(world, agent.id, usage, funding.allocationId);
  return outcome;
}
