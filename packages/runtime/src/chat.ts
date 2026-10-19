/** Proxy chat: one cheap call, no tools. The librarian (`service`) answers from the library index + search hits. */
import { AppError, searchDocs } from "@agent-town/core";
import { ChatInput } from "@agent-town/schema";
import { chatContext, chatSystemPrompt, historyBlock, librarianContext, librarianSystemPrompt } from "./prompts.ts";
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
    context = chatContext(agent, assignment, latestReport(ctx, agentId), world.events.recent({ agentId, limit: 40 }));
  }
  const funding = fundingFor(world, agentId);
  const out = await oneShot(ctx.sdk, { model, system, prompt: `${context}\n\n${historyBlock(input.history, input.message)}`, apiKey: funding.apiKey });
  chargeUsage(world, agentId, out, funding.allocationId);
  if (!out.text) return { reply: out.error ? `(${agent.name} can't answer right now: ${out.error})` : `(${agent.name} has nothing to say.)` };
  return { reply: out.text };
}
