/** Host-executed admin verbs (v1.3). The work happens in the runtime on the host; core only checks permissions. */
import type { Agent } from "@muster-town/schema";
import { AppError, forbidden } from "../errors.ts";
import type { World } from "../world.ts";
import type { VerbIn } from "./types.ts";

/** Pull main, reinstall, rebuild, restart. Needs `town.redeploy`: role `deployer`, admin, or (outside a hosted collective) a building manager and its forks. */
export async function redeploy(world: World, me: Agent, input: VerbIn<"redeploy">) {
  if (!world.permissions.can(me, "town.redeploy")) throw forbidden("town.redeploy");
  const run = world.host.redeploy;
  if (!run) throw new AppError("unreachable", "Redeploy is unavailable: the runtime is not running on the host.");
  const r = run({ image: input.image, requestedBy: me.name });
  // host sessions are drained (a working host agent that waits for the restart deadlocks it, Sage 2026-10-20); desk sessions are adopted across it (0559aba)
  if (world.host.isWorking?.(me.id)) return { ...r, note: REDEPLOY_NOTE };
  return r;
}

/** Told to an agent that redeploys from inside its own work session. */
const REDEPLOY_NOTE = "The server restarts as soon as no host session is running (it waits up to 3 min for those); a desk work session like most agents' keeps running through the restart and the next server adopts it. Still never wait or poll for the new build in this session: say in your report which commit should be live, submit the report, and verify on your next session.";
