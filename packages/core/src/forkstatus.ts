/**
 * `fork_status` (agent teams step 2, article dc_i7ji4xacd9): what a running fork is doing, for its manager. The tool calls
 * and thoughts come from the event log (`agent.tool` / `agent.thought` of the fork's live session); each call's one-line
 * result comes from `ToolResults`, an in-memory ring fed by host sessions and desks (DeskActivityInput kind `result`).
 * Results are not persisted: after a restart, or from a desk image without the `result` post, a call shows no result.
 */
import type { Agent, Session } from "@muster-town/schema";
import { sessionView } from "./bank.ts";
import { homeOf } from "./domain.ts";
import { AppError, badRequest, forbidden } from "./errors.ts";
import type { World } from "./world.ts";

const LINE_CHARS = 160;
/** results kept per session (newest), and sessions kept at all */
const PER_SESSION = 100;
const SESSIONS = 200;

/** First non-empty line of `s`, clipped. */
function firstLine(s: string, n = LINE_CHARS): string {
  const line = s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > n ? line.slice(0, n - 1) + "…" : line;
}

/** A tool_result block's content (string or text blocks) as one line. */
export function resultLine(content: unknown): string {
  if (typeof content === "string") return firstLine(content);
  if (Array.isArray(content)) return firstLine(content.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("\n"));
  return "";
}

interface ToolResult { line: string; isError: boolean }

/** Live sessions' tool results by tool_use id: the newest PER_SESSION per session, the newest SESSIONS sessions. */
export class ToolResults {
  private bySession = new Map<string, Map<string, ToolResult>>();
  record(sessionId: string, toolUseId: string, line: string, isError = false): void {
    let m = this.bySession.get(sessionId);
    if (!m) {
      m = new Map();
      this.bySession.set(sessionId, m);
      if (this.bySession.size > SESSIONS) this.bySession.delete(this.bySession.keys().next().value!);
    }
    m.set(toolUseId, { line: firstLine(line), isError });
    if (m.size > PER_SESSION) m.delete(m.keys().next().value!);
  }
  get(sessionId: string, toolUseId: string | null | undefined): ToolResult | null {
    return (toolUseId && this.bySession.get(sessionId)?.get(toolUseId)) || null;
  }
}

/** The input's first line: the main field of a tool's input (command, query, file path, title …), else the JSON. */
export function inputLine(raw: unknown): string {
  let v = raw;
  if (typeof raw === "string") { try { v = JSON.parse(raw); } catch { return firstLine(raw); } }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const k of ["command", "query", "file_path", "pattern", "url", "title", "id", "to", "text", "action", "prompt", "description"]) {
      if (typeof o[k] === "string" && o[k]) return firstLine(`${k}: ${o[k] as string}`);
    }
  }
  return firstLine(typeof raw === "string" ? raw : JSON.stringify(v ?? ""));
}

export interface ForkStatusCall { at: string; tool: string; what: string; input: string; result: string | null; isError: boolean }
export interface ForkStatus {
  fork: { id: string; name: string; status: Agent["status"] };
  assignment: { id: string; title: string; lane: string; grantId: string | null; keyResultId: string | null; sourceId: string | null; status: string } | null;
  session: { id: string; status: Session["status"]; startedAt: string; endedAt: string | null; minutes: number; adjustedTokensSoFar: number; reportId: string | null } | null;
  lastThought: { at: string; text: string } | null;
  calls: ForkStatusCall[];
  note: string;
}

/** The fork named by `forkId`, or the fork running (or that ran) `assignmentId`. */
function resolveFork(world: World, forkId?: string, assignmentId?: string): Agent {
  if (forkId) return world.agents.require(forkId, "agent");
  if (!assignmentId) throw badRequest("Give forkId or assignmentId.");
  const a = world.assignments.require(assignmentId, "assignment");
  const s = world.sessions.first("assignmentId = ?", [a.id], "ORDER BY startedAt DESC, rowid DESC");
  const id = s?.agentId ?? (world.db.prepare("SELECT agentId FROM events WHERE type = 'agent.forked' AND json_extract(payload, '$.assignmentId') = ? ORDER BY id DESC LIMIT 1").get(a.id) as { agentId: string } | undefined)?.agentId ?? a.agentId;
  return world.agents.require(id, "agent");
}

/** `fork_status`: the manager (building.assign) of the fork's building, or anyone who may read its transcript. */
export function forkStatus(world: World, me: Agent, input: { forkId?: string; assignmentId?: string; limit?: number }): ForkStatus {
  const fork = resolveFork(world, input.forkId, input.assignmentId);
  if (!fork.forkOf) throw badRequest(`${fork.name} is not a fork; fork_status reads a fork's live session.`);
  const bid = homeOf(fork);
  const session = world.sessions.first("agentId = ?", [fork.id], "ORDER BY startedAt DESC, rowid DESC") ?? null;
  const may = (bid && world.permissions.can(me, "building.assign", bid)) || (session && world.transcripts.canRead(me, session));
  if (!may) throw forbidden("building.assign");
  if (!session && fork.status === "retired") throw new AppError("not_found", `${fork.name} retired before its session started.`);
  const asgId = session?.assignmentId ?? fork.currentAssignmentId ?? null;
  const asg = asgId ? world.assignments.get(asgId) : null;
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 40);
  const rows = session ? (world.db.prepare(
    "SELECT ts, type, text, payload FROM events WHERE agentId = ? AND type IN ('agent.tool', 'agent.thought') AND ts >= ? AND json_extract(payload, '$.sessionId') = ? ORDER BY id DESC LIMIT ?",
  ).all(fork.id, session.startedAt, session.id, limit * 4) as { ts: string; type: string; text: string; payload: string }[]) : [];
  const calls: ForkStatusCall[] = [];
  let lastThought: ForkStatus["lastThought"] = null;
  for (const r of rows) {
    if (r.type === "agent.thought") { lastThought ??= { at: r.ts, text: r.text }; continue; }
    if (calls.length >= limit) continue;
    const p = JSON.parse(r.payload || "{}") as { tool?: string; input?: unknown; toolUseId?: string };
    const res = world.toolResults.get(session!.id, p.toolUseId);
    calls.push({ at: r.ts, tool: (p.tool ?? "tool").replace(/^mcp__town__/, ""), what: r.text, input: inputLine(p.input ?? ""), result: res?.line ?? null, isError: res?.isError ?? false });
  }
  calls.reverse();
  const end = session?.endedAt ? Date.parse(session.endedAt) : Date.now();
  const running = session?.status === "running";
  return {
    fork: { id: fork.id, name: fork.name, status: fork.status },
    assignment: asg ? { id: asg.id, title: asg.title, lane: asg.lane, grantId: asg.grantId, keyResultId: asg.keyResultId, sourceId: asg.sourceId ?? null, status: asg.status } : null,
    session: session ? { id: session.id, status: session.status, startedAt: session.startedAt, endedAt: session.endedAt ?? null, minutes: Math.round((end - Date.parse(session.startedAt)) / 60000), adjustedTokensSoFar: sessionView(session).adjustedOutputTokens, reportId: session.reportId ?? null } : null,
    lastThought, calls,
    note: !session ? `${fork.name} has no session yet (its desk is starting).`
      : running ? "Calls oldest first. Tokens are what the Bank has booked so far (desks post usage every few seconds). A call without a result is still running, or its result wasn't reported."
      : `${fork.name}'s session ${session.status}${session.reportId ? ` with report ${session.reportId}` : " without a report"}.`,
  };
}
