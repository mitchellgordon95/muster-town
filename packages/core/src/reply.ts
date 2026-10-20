/**
 * Reports as replies (design review 4): reviewing a report = one text box, one button.
 * The reply is appended to the report body as a dated section, delivered to the author as a `mention`, and becomes
 * the author's next assignment. An empty reply archives (acknowledges) the report. A reply starting with "merge"
 * tells the author to merge its own PR and report back.
 */
import type { Agent, Assignment, Doc } from "@agent-town/schema";
import { createAssignment, sendMessage, updateDoc } from "./domain.ts";
import { AppError } from "./errors.ts";
import type { Holder } from "./permissions.ts";
import { nowIso, truncate } from "./util.ts";
import type { World } from "./world.ts";

export const MERGE_INSTRUCTION = "Merge your pull request for this report (gh pr ready <n> && gh pr merge <n> --squash --delete-branch), confirm the merge, and report back with \"Nothing needed\" unless something failed.";

const pad = (n: number) => String(n).padStart(2, "0");
/** `YYYY-MM-DD HH:mm`, local time. */
export function replyStamp(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Whether a reply asks the author to merge its PR (`merge`, `Merge it`, `merge, then …`). */
export const isMergeReply = (text: string) => /^merge\b/i.test(text.trim());

export interface ReplyResult { doc: Doc; assignment: Assignment | null }

/**
 * Reply to a report. `replier` is the acting agent (a user's avatar) or null for system.
 * Permission checks are the caller's (ops). Works on pending and already-handled reports; an empty reply on an
 * already-handled report changes nothing.
 */
export function replyToReport(world: World, replier: Agent | null, docId: string, rawText: string): ReplyResult {
  const report = world.docs.require(docId, "doc");
  if (report.type !== "report") throw new AppError("bad_request", `Doc ${docId} is a ${report.type}, not a report.`);
  const text = rawText.trim();
  if (!text && report.decision && report.decision !== "pending") return { doc: report, assignment: null };
  const by: Holder | { kind: "system"; id: string } = replier ? world.holderOf(replier) : { kind: "system", id: "system" };
  const name = replier?.name ?? "System";
  return world.transaction(() => {
    const ts = nowIso();
    const body = text ? `${report.body.replace(/\s+$/, "")}\n\n## Reply from ${name} (${replyStamp()})\n\n${text}\n` : report.body;
    const doc = updateDoc(world, docId, { body, decision: "approve", decidedBy: by.id, decidedAt: ts, decisionNote: text || undefined });
    const author = world.agents.get(report.authorId);
    world.events.append({
      type: "doc.decision", agentId: author?.id ?? null, buildingId: doc.buildingId,
      text: text ? `${name} replied to "${doc.title}": ${truncate(text, 80)}` : `Archived: "${doc.title}"`,
      payload: { docId, decision: "approve", note: text, decidedBy: by.id, reply: !!text },
    });
    if (!text || !author) return { doc, assignment: null };

    const msgBody = `${name} replied to your report "${report.title}": ${truncate(text.replace(/\s+/g, " "), 200)}`;
    const msg = sendMessage(world, { kind: "mention", fromId: by.id, fromKind: by.kind, toId: author.id, body: msgBody, docId });
    world.events.append({
      type: "agent.mentioned", agentId: author.id, buildingId: doc.buildingId, text: msgBody,
      payload: { byId: by.id, byKind: by.kind, toId: author.id, toKind: author.kind, messageId: msg.id, docId },
    });

    if (author.status === "retired" || author.status === "banned") return { doc, assignment: null };
    let description = `${name}'s reply: ${text}\n\nThe report: ${report.title} (doc ${report.id}). Read it with \`read\`, do what the reply asks, and finish with a report whose last section says what you need next or "Nothing needed".`;
    if (isMergeReply(text)) description = `${MERGE_INSTRUCTION}\n\n${description}`;
    const assignment = createAssignment(world, {
      agentId: author.id, title: truncate(`Reply on: ${report.title}`, 120), description, createdBy: by, fromReportId: report.id,
      ...(report.buildingId && !author.homeBuildingId && !author.buildingId ? { buildingId: report.buildingId } : {}),
    });
    if (author.status === "stopped") world.setStatus(author.id, "idle");
    return { doc, assignment };
  });
}
