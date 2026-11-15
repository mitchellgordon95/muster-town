import { AskCardInput, VERB_NAMES, VerbInputs, type Agent, type Ask, type VerbName } from "@muster-town/schema";
import { entryOf } from "../jobs.ts";
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
import { askHumans } from "../ask-verb.ts";
import { rewriteAsk, withdrawAsk } from "../asks.ts";
import type { VerbIn, VerbRawIn } from "./types.ts";

/** The rewrite and withdraw forms answer like a filed card: the ask, the entry it views and that entry's job. */
const onThread = (world: World, a: Ask) => ({ askId: a.id, entryId: a.sourceEntryId ?? "", jobId: (a.sourceEntryId ? entryOf(world, a.sourceEntryId)?.jobId : undefined) ?? "", folded: false, status: a.status });

export const verbImpls = {
  look, town, go, say, tell, inbox, board, search, read, write, skills, pin, submit_report, request_human, withdraw_request,
  assignments, accept_assignment, meeting, review, assign, schedule, cancel, stop_fork, fork_status: async (world: World, me: Agent, input: VerbIn<"fork_status">) => forkStatus(world, me, input), propose_grant, close_grant, withdraw_grant, set_objective,
  act_in_1on1: async (world: World, me: Agent, input: VerbIn<"act_in_1on1">) => actForHuman(world, me, input), propose_goal, promote, ban, redeploy,
  ask: async (world: World, me: Agent, input: VerbIn<"ask">) => {
    const bid = me.homeBuildingId ?? me.buildingId;
    if (!bid || !world.permissions.can(me, "building.manage", bid)) throw new AppError("forbidden", "Only a building's manager asks the humans (building.manage); a fork puts what it needs in its report's \"What I need from you\".");
    if (input.askId) {
      const id = input.askId;
      if (input.withdraw) {
        const a = world.transaction(() => withdrawAsk(world, me, id, input.withdraw!));
        return { ...onThread(world, a), note: `Withdrew ask ${a.id}: it left the humans' decision queue (retired, kept with your note on it and on its thread). Nobody is woken.` };
      }
      if (!input.title) throw new AppError("bad_request", "ask with askId: give title, body and recommendation to write the card again whole, or withdraw with a note.");
      const a = world.transaction(() => rewriteAsk(world, me, id, { title: input.title, body: input.body, recommendation: input.recommendation }));
      const lint = a.history.at(-1)?.action === "lint" ? a.history.at(-1)!.note : "";
      return { ...onThread(world, a), note: `Rewrote ask ${a.id} whole (its type, branches and target are kept).${lint ? ` Style ${lint.slice(0, 1200)}` : ""}` };
    }
    if (input.withdraw) throw new AppError("bad_request", "withdraw needs askId: the live ask of your building to take back.");
    const card = AskCardInput.safeParse(input);
    if (!card.success) throw new AppError("bad_request", `Invalid input for ask: a new card needs type, title and branches (${card.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}).`);
    const r = world.transaction(() => askHumans(world, me, bid, { ...card.data, jobId: input.jobId, note: input.note }));
    const { warnings, ...filed } = r;
    return { ...filed, ...(warnings.length ? { warnings } : {}), note: `Filed as ask ${r.askId}${r.folded ? " (already open on that need or item: your card is refused as a second card and your words are one entry on its thread; the card stays as written until it is rewritten whole, by its building's manager with `ask` askId, or by the Secretary)" : ""} in the humans' decision queue, on the thread of ${r.jobId}. Their decision comes back to your in-tray as an entry on that thread; don't wait in this session.${warnings.length ? ` It is filed with ${warnings.length} style warning(s), kept in its history; next time: ${warnings.join("; ").slice(0, 1200)}.` : ""}` };
  },
  rank: async (world: World, me: Agent, input: VerbIn<"rank">) => {
    if (!world.secretary.isSecretary(me)) throw new AppError("forbidden", "Only the Town Hall's Secretary ranks the asks.");
    if (input.pattern) return filePattern(world, me, input.pattern);
    if (input.week) return { inputs: weekInputsText(world) };
    if (!input.order && !input.slate && !input.defer && !input.overtaken && !input.fold && !input.rewrite && !input.render) return { inputs: rankInputsText(world) };
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
