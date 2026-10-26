import { VERB_NAMES, VerbInputs, type Agent, type VerbName } from "@muster-town/schema";
import { AppError } from "../errors.ts";
import type { World } from "../world.ts";
import { redeploy } from "./admin.ts";
import { assign, board, cancel, pin, promote, propose_trophy, read, reassign, request_human, review, search, skills, submit_report, write } from "./docs.ts";
import { checkpoint_grant, propose_grant, set_key_result } from "./grants.ts";
import { meeting } from "./meeting.ts";
import { accept_assignment, assignments, ban, go, inbox, look, say, tell } from "./social.ts";
import type { VerbIn, VerbRawIn } from "./types.ts";

export const verbImpls = {
  look, go, say, tell, inbox, board, search, read, write, skills, pin, submit_report, propose_trophy, request_human,
  assignments, accept_assignment, meeting, review, assign, reassign, cancel, propose_grant, checkpoint_grant, set_key_result, promote, ban, redeploy,
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
