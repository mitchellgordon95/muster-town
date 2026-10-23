/** Proxy chat: one cheap call, no tools. The librarian (`service`) answers from the library index + search hits. */
import { AppError, codeWorkspace, searchDocs } from "@muster-town/core";
import { ChatInput } from "@muster-town/schema";
import { chatContext, chatSystemPrompt, historyBlock, librarianContext, librarianSystemPrompt, memoryBlock, recentWorkBlock } from "@muster-town/core";
import { oneShot } from "./sdk.ts";
import { chargeUsage, fundingFor, homeOf, type Ctx } from "./session.ts";
import { latestReport } from "./work.ts";

const LIBRARY_INDEX_LIMIT = 200;

export async function chat(ctx: Ctx, agentId: string, raw: (typeof ChatInput)["_input"]): Promise<{ reply: string }> {
  const { world } = ctx;
  const input = ChatInput.parse(raw);
  const agent = world.agents.require(agentId, "agent");
  if (agent.kind === "human") throw new AppError("bad_request", "Humans answer for themselves.");
  const bid = homeOf(world, agentId);
  const building = bid ? world.buildings.get(bid) : undefined;
  const model = building?.cheapModel ?? "claude-haiku-5-5";
  const town = world.town.get();
  let system: string;
  let context: string;
  if (agent.kind === "service") {
    const index = world.docs.where("state IN ('library','trophy')", [], `ORDER BY updatedAt DESC LIMIT ${LIBRARY_INDEX_LIMIT}`);
    const hits = searchDocs(world, agent.id, { query: input.message, limit: 6 }).filter((d) => d.state !== "draft");
    system = librarianSystemPrompt(agent, town);
    context = librarianContext(index, hits, (id) => (id ? world.buildings.get(id)?.name ?? id : "town"));
  } else {
    const assignment = agent.currentAssignmentId ? world.assignments.get(agent.currentAssignmentId) : undefined;
    system = chatSystemPrompt(agent);
    context = chatContext(agent, assignment, latestReport(ctx, agentId), world.events.recent({ agentId, limit: 40 }),
      { recentWork: recentWorkBlock(world, agentId, { readHint: false }), memory: memoryBlock(world, agentId) });
  }
  const funding = fundingFor(world, agentId);
  const out = await oneShot(ctx.sdk, { model, system, prompt: `${context}\n\n${historyBlock(input.history, input.message)}`, apiKey: funding.apiKey });
  chargeUsage(world, agentId, out, funding.allocationId);
  if (!out.text) return { reply: out.error ? `(${agent.name} can't answer right now: ${out.error})` : `(${agent.name} has nothing to say.)` };
  return { reply: out.text };
}

/**
 * "Ask about this" (in-tray): answer a reviewer's question about a report without bothering its author.
 * One cheap call, no tools; context = the report, the author's latest events, the building's goal and rules.
 * Charged to the report's building like proxy chat.
 */
export async function askAbout(ctx: Ctx, docId: string, question: string, userId: string, history: { role: "user" | "assistant"; text: string }[] = []): Promise<{ reply: string }> {
  const { world } = ctx;
  const doc = world.docs.require(docId, "doc");
  const author = world.agents.get(doc.authorId);
  const bid = doc.buildingId ?? (author ? homeOf(world, author.id) : null);
  const building = bid ? world.buildings.get(bid) : undefined;
  const model = building?.cheapModel ?? "claude-haiku-5-5";
  const asker = world.users.get(userId)?.name ?? "the reviewer";
  const authorName = author?.name ?? world.nameOf(doc.authorId);
  const system = `You help ${asker} review a report written by ${authorName}${building ? ` in ${building.name}` : ""}. You are not ${authorName}; answer in your own voice about what the report says and what ${authorName} has been doing, using only the context provided. Be brief (2-5 sentences). Quote the report when it helps. If the context doesn't answer the question, say so plainly; never invent findings. If ${asker} wants ${authorName} to do something, tell them to write it as a reply.`;
  const events = author ? world.events.recent({ agentId: author.id, limit: 15 }) : [];
  const ws = codeWorkspace(world.town.get(), building);
  const rules = building ? [
    `Building: ${building.name}. Goal: ${building.goal || "(none)"}.`,
    ...(building.description ? [`About: ${building.description}`] : []),
    `Review policy: ${building.reviewPolicy}.${ws ? ` Code access to the collective repo: ${ws.repoUrl ?? "(none)"}.` : ""}`,
  ].join("\n") : "Building: (none)";
  const body = doc.body.length > 8000 ? `${doc.body.slice(0, 8000)}\n…(truncated)` : doc.body;
  const context = `${rules}

Report "${doc.title}" by ${authorName} (${doc.id}), ${doc.createdAt.slice(0, 16)}, decision: ${doc.decision ?? "?"}${doc.verdict ? `, verdict: ${doc.verdict}` : ""}
---
${body}
---

${authorName}'s status: ${author?.status ?? "?"}. Doing: ${author?.activity || "(nothing)"}
${authorName}'s latest activity:
${events.map((e) => `- ${e.ts.slice(0, 16)} [${e.type}] ${e.text}`).join("\n") || "(none)"}`;
  const charged = author && author.kind !== "human" ? author.id : null;
  const funding = charged ? fundingFor(world, charged) : { allocationId: null, apiKey: null };
  const out = await oneShot(ctx.sdk, { model, system, prompt: `${context}\n\n${historyBlock(history, question)}`, apiKey: funding.apiKey });
  if (charged) chargeUsage(world, charged, out, funding.allocationId);
  if (!out.text) return { reply: out.error ? `(No answer right now: ${out.error})` : "(No answer.)" };
  return { reply: out.text };
}
