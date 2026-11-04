import { VERB_NAMES, VerbInputs, type Agent, type VerbName } from "@muster-town/schema";
import { AppError } from "../errors.ts";
import type { World } from "../world.ts";
import { redeploy } from "./admin.ts";
import { assign, board, cancel, pin, promote, read, request_human, review, schedule, search, skills, submit_report, write } from "./docs.ts";
import { checkpoint_grant, close_grant, propose_goal, propose_grant, set_objective, withdraw_grant } from "./grants.ts";
import { meeting } from "./meeting.ts";
import { forkStatus } from "../forkstatus.ts";
import { actForHuman } from "../act-in-1on1.ts";
import { adoptGoal } from "../entities.ts";
import { digestInputsText, fileDigest } from "../secretary.ts";
import { accept_assignment, assignments, ban, go, inbox, look, say, stop_fork, tell, town } from "./social.ts";
import type { VerbIn, VerbRawIn } from "./types.ts";

export const verbImpls = {
  look, town, go, say, tell, inbox, board, search, read, write, skills, pin, submit_report, request_human,
  assignments, accept_assignment, meeting, review, assign, schedule, cancel, stop_fork, fork_status: async (world: World, me: Agent, input: VerbIn<"fork_status">) => forkStatus(world, me, input), propose_grant, checkpoint_grant, close_grant, withdraw_grant, set_objective,
  act_in_1on1: async (world: World, me: Agent, input: VerbIn<"act_in_1on1">) => actForHuman(world, me, input), propose_goal, promote, ban, redeploy,
  digest: async (world: World, me: Agent, input: VerbIn<"digest">) => {
    if (!world.secretary.isSecretary(me)) throw new AppError("forbidden", "Only the Town Hall's Secretary works the digest.");
    if (!input.shipped) return { inputs: digestInputsText(world) };
    const doc = fileDigest(world, me, input.shipped);
    return { digestId: doc.id, covered: doc.provenance.sourceIds, note: `Filed ${doc.id} in the Town Hall. Now submit_report (verdict stop) naming it.` };
  },
  adopt: async (world: World, me: Agent, input: VerbIn<"adopt">) => {
    const { building, desk } = adoptGoal(world, me.id, input.goalId);
    return { buildingId: building.id, name: building.name, goalId: building.goalId, manager: me.id, desk, note: `You manage ${building.name} now: \`tell\` to ${building.id} reaches you, its in-tray is yours. The town never forks a visitor, so do its work yourself (assign with your own agentId).` };
  },
} satisfies { [K in VerbName]: (world: World, actor: Agent, input: VerbIn<K>) => Promise<unknown> };

export type VerbResult<K extends VerbName> = Awaited<ReturnType<(typeof verbImpls)[K]>>;

/** `world.verbs.<name>(actor, input)`: input is parsed with the schema; actor is re-read from the DB. */
export type Verbs = { [K in VerbName]: (actor: Agent | string, input?: VerbRawIn<K>) => Promise<VerbResult<K>> };

export function makeVerbs(world: World): Verbs {
  const verbs: Record<string, (actor: Agent | string, input?: unknown) => Promise<unknown>> = {};
  for (const name of VERB_NAMES) {
    verbs[name] = async (actor, input = {}) => {
      const parsed = VerbInputs[name].safeParse(input);
      if (!parsed.success) {
        throw new AppError("bad_request", `Invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`);
      }
      const me = world.agents.get(typeof actor === "string" ? actor : actor.id);
      if (!me) throw new AppError("not_found", "Unknown agent.");
      if (me.status === "banned") throw new AppError("forbidden", "You are banned.");
      if (me.status === "retired") throw new AppError("forbidden", "You were dismissed.");
      const impl = verbImpls[name] as (w: World, a: Agent, i: unknown) => Promise<unknown>;
      return impl(world, me, parsed.data);
    };
  }
  return verbs as Verbs;
}
