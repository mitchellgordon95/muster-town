/**
 * The tool calls behind an agent's meeting line (Mitchell, 1:1 mt_db6itzy2br: "we should see tool calls (summarized) in
 * 1:1 chats"). When an agent speaks, the `agent.tool` events it emitted since its previous line in that meeting are kept
 * on the utterance: each call's readable one-liner (describeTool, the same text the map bubbles show), never the raw input.
 * A result line comes from the in-memory `toolResults` ring (fork_status): kept for town tools and for errors, with
 * secret-looking runs hidden; a built-in tool's ordinary output (a file, a shell's stdout) is never kept.
 */
import type { MeetingToolCall } from "@muster-town/schema";
import type { World } from "./world.ts";

/** at most this many calls per line (the newest) */
export const MEETING_TOOLS_MAX = 30;

/** Long opaque tokens (mixed case and digits), known token prefixes and `key=value` secrets become "[hidden]". */
export function hideSecrets(s: string): string {
  return s
    .replace(/\b(gh[pousr]_|github_pat_|sk-|xox[abp]-)[A-Za-z0-9_-]{8,}/g, "[hidden]")
    .replace(/\b([A-Za-z_]*(?:token|secret|password|passwd|api[_-]?key|auth)[A-Za-z_]*)\s*[=:]\s*\S+/gi, "$1=[hidden]")
    .replace(/[A-Za-z0-9_\-+/=]{24,}/g, (run) => (/[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run) ? "[hidden]" : run));
}

/** `agentId`'s tool calls after `since` (ISO), oldest first, without its own meeting calls (listen, speak). */
export function toolCallsSince(world: World, agentId: string, since: string): MeetingToolCall[] {
  const rows = world.db.prepare(
    "SELECT text, payload FROM events WHERE agentId = ? AND type = 'agent.tool' AND ts > ? ORDER BY id DESC LIMIT ?",
  ).all(agentId, since, MEETING_TOOLS_MAX + 10) as { text: string; payload: string }[];
  const out: MeetingToolCall[] = [];
  for (const r of rows) {
    let p: { tool?: string; toolUseId?: string; sessionId?: string } = {};
    try { p = JSON.parse(r.payload || "{}"); } catch { /* a bad payload still shows its line */ }
    if (p.tool === "mcp__town__meeting") continue;
    const res = p.sessionId ? world.toolResults.get(p.sessionId, p.toolUseId) : null;
    const keep = res && res.line && (res.isError || p.tool?.startsWith("mcp__town__"));
    out.push({ what: hideSecrets(r.text), ...(keep ? { result: hideSecrets(res.line) } : {}), ...(res?.isError ? { isError: true } : {}) });
    if (out.length >= MEETING_TOOLS_MAX) break;
  }
  return out.reverse();
}
