/**
 * A new building's name (flag dc_42c9cjbzls): when the goal editor adds the first desk under a goal, one short call on
 * the building's cheap model (Haiku) names it like a place ("Onboarding", "Bank Transparency") instead of the goal's
 * words verbatim. Funded through the Bank and booked like any host call, on the new building's manager. The goal's
 * short text (core `GoalTree.defaultName`, what createBuilding already set) stays when the call fails, comes back
 * unusable, or the Bank can't run it.
 */
import { NoCredential, type World } from "@muster-town/core";
import type { Building } from "@muster-town/schema";
import { oneShot } from "./sdk.ts";
import { chargeUsage, fundingFor, type Ctx } from "./session.ts";

const NAME_MAX_CHARS = 32;
const NAME_MAX_WORDS = 4;

const NAMING_SYSTEM = [
  "You name buildings in a small pixel-art town where AI agents work toward goals.",
  "Given a goal, answer with only the building's name: 1 to 3 words, Title Case, a short place-like name for the team that works the goal,",
  "like \"Onboarding\", \"Bank Transparency\", \"Prod\", \"Code Legibility\". No quotes, no punctuation, no explanation.",
].join(" ");

/** The model's answer as a building name, or null when it isn't one (empty, a sentence, too long). Pure: tested. */
export function cleanBuildingName(raw: string): string | null {
  const line = raw.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const name = line
    .replace(/^(name|building name)\s*:\s*/i, "")
    .replace(/^[\s"'`*“”‘’]+|[\s"'`*“”‘’.!,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!name || name.length > NAME_MAX_CHARS || name.split(" ").length > NAME_MAX_WORDS) return null;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} &'’/+-]*$/u.test(name)) return null;
  return name;
}

/**
 * Name a just-created building from its goal: one call on its cheap model, booked on its manager; renames it when the
 * answer is a usable name. Returns the building as it ends up (unchanged on any failure). Never throws.
 */
export async function nameBuilding(ctx: Ctx, buildingId: string): Promise<Building> {
  const { world } = ctx;
  const building = world.buildings.require(buildingId, "building");
  try {
    const name = await askName(ctx, world, building);
    if (!name || name === building.name) return building;
    return world.ops.updateBuilding(null, buildingId, { name });
  } catch (e) {
    console.log("[runtime] building naming failed:", e instanceof Error ? e.message : e);
    return world.buildings.require(buildingId, "building");
  }
}

async function askName(ctx: Ctx, world: World, building: Building): Promise<string | null> {
  const agentId = building.managerAgentId;
  // not budget.canStart: a building made a moment ago has no daily room yet in a goal-directed town; the call is a few
  // hundred tokens and is booked like any (a building with nothing left overshoots its last source, as every host call does)
  if (!agentId) return null;
  const goal = world.goalTree.purposeOf(building).trim();
  if (!goal) return null;
  const model = building.cheapModel;
  let funding;
  try { funding = fundingFor(world, agentId, model); }
  catch (e) { if (e instanceof NoCredential) return null; throw e; }
  const session = world.ops.startSession(agentId, { purpose: "naming", model, credentialInputId: funding.credential.inputId ?? null });
  const out = await oneShot(ctx.sdk, { model, system: NAMING_SYSTEM, prompt: `Goal: ${goal}\n\nThe building's name:`, credential: funding.credential, env: ctx.env, hosted: !!ctx.hosted || world.bank.hosted() });
  const name = out.error ? null : cleanBuildingName(out.text);
  const error = out.error ?? (name ? null : `unusable name: ${out.text.slice(0, 80)}`);
  world.ops.endSession(session.id, { status: out.error ? "error" : "done", counts: out.counts, byModel: out.byModel, costUsd: out.costUsd, turns: out.turns, error });
  chargeUsage(world, agentId, out, funding.allocationId, model);
  return name;
}
