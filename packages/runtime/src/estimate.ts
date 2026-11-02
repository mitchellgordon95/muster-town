/**
 * A grant's cost estimate from the cheap model (Mitchell, 1:1 mt_c9u1kr15jp, step 2; docs/how-work-gets-done.md §4 "What a
 * grant is likely to cost"): right after a propose, one call on the building's cheapModel, shown the collective's closed
 * grants and the new plan (core `modelEstimatePrompt`), answers a low–high range in adjusted tokens and one sentence of
 * reasoning. Saved beside the propose-time range (`estimate.model`). Funded through the Bank (`fundingFor`, never an env
 * key) and booked like any host call on the building's manager, in the directed lane. Advisory only: the proposal has
 * already landed; when the call fails, the answer is unusable or the Bank can't run it, the grant keeps its history range.
 */
import { MODEL_ESTIMATE_SYSTEM, NoCredential, modelEstimatePrompt, nowIso, parseModelEstimate } from "@muster-town/core";
import { oneShot } from "./sdk.ts";
import { chargeUsage, fundingFor, type Ctx } from "./session.ts";

/** Grants with a call running, per runtime: the wake rule and the boot sweep never ask twice at once. */
const running = new WeakMap<Ctx, Set<string>>();

/** Estimate a just-proposed grant with the cheap model; true when a range was saved. Never throws. */
export async function estimateGrantWithModel(ctx: Ctx, grantId: string): Promise<boolean> {
  const mine = running.get(ctx) ?? new Set<string>();
  running.set(ctx, mine);
  if (mine.has(grantId)) return false;
  mine.add(grantId);
  try {
    return await ask(ctx, grantId);
  } catch (e) {
    console.log("[runtime] grant estimate failed:", e instanceof Error ? e.message : e);
    return false;
  } finally {
    mine.delete(grantId);
  }
}

async function ask(ctx: Ctx, grantId: string): Promise<boolean> {
  const { world } = ctx;
  const g = world.grants.get(grantId);
  if (!g?.estimate || g.estimate.model || g.status !== "proposed") return false;
  const building = world.buildings.get(g.buildingId);
  const agentId = building?.managerAgentId;
  if (!building || !agentId) return false;
  const model = building.cheapModel;
  let funding;
  try { funding = fundingFor(world, agentId, model); }
  catch (e) { if (e instanceof NoCredential) return false; throw e; }
  const at = g.estimate.at;
  const session = world.ops.startSession(agentId, { purpose: "estimate", model, lane: "directed", credentialInputId: funding.credential.inputId ?? null });
  const out = await oneShot(ctx.sdk, { model, system: MODEL_ESTIMATE_SYSTEM, prompt: modelEstimatePrompt(world, grantId), credential: funding.credential, env: ctx.env, hosted: !!ctx.hosted || world.bank.hosted() });
  const range = out.error ? null : parseModelEstimate(out.text);
  const error = out.error ?? (range ? null : `unusable estimate: ${out.text.slice(0, 80)}`);
  world.ops.endSession(session.id, { status: out.error ? "error" : "done", counts: out.counts, byModel: out.byModel, costUsd: out.costUsd, turns: out.turns, error });
  chargeUsage(world, agentId, out, funding.allocationId, model);
  if (!range) return false;
  return world.grantDesk.recordModelEstimate(grantId, at, { ...range, modelId: model, sessionId: session.id, at: nowIso() });
}

/**
 * At boot: every open proposal without the model's range gets one call (the wake rule is not replayed, so a proposal
 * made while the server was down, or before this step shipped, is caught here). One that has no recorded estimate yet
 * (proposed before migration 083) records its history range first. At most one try per proposal per boot.
 */
export async function estimateOpenProposals(ctx: Ctx): Promise<number> {
  let saved = 0;
  for (const g of ctx.world.grants.where("status = 'proposed'", [], "ORDER BY updatedAt, rowid")) {
    if (g.estimate?.model) continue;
    if (!g.estimate) ctx.world.grantDesk.recordEstimate(g.id);
    if (await estimateGrantWithModel(ctx, g.id)) saved++;
  }
  return saved;
}
