import { VERB_NAMES, VerbInputs, type Agent, type VerbName } from "@muster-town/schema";
import { AppError } from "../errors.ts";
import type { World } from "../world.ts";
import { redeploy } from "./admin.ts";
import { assign, board, cancel, pin, promote, read, request_human, review, schedule, search, skills, submit_report, withdraw_request, write } from "./docs.ts";
import { close_grant, propose_goal, propose_grant, set_objective, withdraw_grant } from "./grants.ts";
import { meeting } from "./meeting.ts";
import { forkStatus } from "../forkstatus.ts";
import { actForHuman } from "../act-in-1on1.ts";
import { adoptGoal } from "../entities.ts";
import { calibrate } from "../planner.ts";
import { applyRank, filePattern, rankInputsText, weekInputsText } from "../secretary.ts";
import { accept_assignment, assignments, ban, go, inbox, look, say, stop_fork, tell, town } from "./social.ts";
import { askHumans, secondCardRefused } from "../ask-verb.ts";
import { rewriteOwnAsk, withdrawAsk } from "../asks.ts";
import { entryOf } from "../jobs.ts";
import type { VerbIn, VerbRawIn } from "./types.ts";

export const verbImpls = {
  look, town, go, say, tell, inbox, board, search, read, write, skills, pin, submit_report, request_human, withdraw_request,
  assignments, accept_assignment, meeting, review, assign, schedule, cancel, stop_fork, fork_status: async (world: World, me: Agent, input: VerbIn<"fork_status">) => forkStatus(world, me, input), propose_grant, close_grant, withdraw_grant, set_objective,
  act_in_1on1: async (world: World, me: Agent, input: VerbIn<"act_in_1on1">) => actForHuman(world, me, input), propose_goal, promote, ban, redeploy,
  ask: async (world: World, me: Agent, input: VerbIn<"ask">) => {
    const bid = me.homeBuildingId ?? me.buildingId;
    if (!bid || !world.permissions.can(me, "building.manage", bid)) throw new AppError("forbidden", "Only a building's manager asks the humans (building.manage); a fork puts what it needs in its report's \"What I need from you\".");
    // the same verb changes one of the building's own asks (1:1 mt_dwsxo7oms8 decision 2 point 5): rewrite it whole, or withdraw it
    if (input.askId) {
      const id = input.askId;
      const jobOf = (a: { sourceEntryId: string | null }) => (a.sourceEntryId ? entryOf(world, a.sourceEntryId)?.jobId : undefined) ?? "";
      if (input.withdraw) {
        const a = world.transaction(() => withdrawAsk(world, me, id, input.note));
        return { askId: a.id, entryId: a.sourceEntryId ?? "", jobId: jobOf(a), folded: false, status: a.status, note: `Withdrew ask ${a.id}: it left the humans' queue (retired, kept on its thread with your note). Nobody is woken.` };
      }
      if (!input.title || !input.body.trim() || !input.recommendation.trim()) throw new AppError("bad_request", "rewrite: give the whole card again, title, body and recommendation together (claims too, if they change). Its type, branches and target stay.");
      const card = { title: input.title, body: input.body, recommendation: input.recommendation, ...(input.claims ? { claims: input.claims } : {}) };
      const a = world.transaction(() => rewriteOwnAsk(world, me, id, card));
      return { askId: a.id, entryId: a.sourceEntryId ?? "", jobId: jobOf(a), folded: false, status: a.status, note: `Wrote ask ${a.id}'s card again, whole. It is the card the humans see now.` };
    }
    if (!input.type || !input.title || !input.branches) throw new AppError("bad_request", "ask: a new ask needs type, title and branches (or askId to rewrite or withdraw one of your building's asks).");
    const r = world.transaction(() => askHumans(world, me, bid, { ...input, type: input.type!, title: input.title!, branches: input.branches! }));
    // a second card on a need is refused loudly, after the commit that keeps its words as an entry on the thread (decision-5 audit rank 1)
    if (r.folded) throw secondCardRefused(r.askId, true);
    const { warnings, ...filed } = r;
    return { ...filed, ...(warnings.length ? { warnings } : {}), note: `Filed as ask ${r.askId} in the humans' decision queue, on the thread of ${r.jobId}. Their decision comes back to your in-tray as an entry on that thread; don't wait in this session.${warnings.length ? ` It is filed with ${warnings.length} style warning(s), kept in its history; next time: ${warnings.join("; ").slice(0, 1200)}.` : ""}` };
  },
  rank: async (world: World, me: Agent, input: VerbIn<"rank">) => {
    if (!world.secretary.isSecretary(me)) throw new AppError("forbidden", "Only the Town Hall's Secretary ranks the asks.");
    if (input.pattern) return filePattern(world, me, input.pattern);
    if (input.week) return { inputs: weekInputsText(world) };
    if (!input.order && !input.slate && !input.defer && !input.overtaken && !input.rewrite && !input.render && !input.fold) return { inputs: rankInputsText(world) };
    return applyRank(world, me, input);
  },
  calibrate: async (world: World, me: Agent, input: VerbIn<"calibrate">) => calibrate(world, me, input),
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
