/** Host-executed admin verbs (v1.3). The work happens in the runtime on the host; core only checks permissions. */
import type { Agent } from "@muster-town/schema";
import { AppError, forbidden } from "../errors.ts";
import type { World } from "../world.ts";
import type { VerbIn } from "./types.ts";

/** Pull main, reinstall, rebuild, restart. Needs `town.redeploy` (role `deployer`, or admin). */
export async function redeploy(world: World, me: Agent, input: VerbIn<"redeploy">) {
  if (!world.permissions.can(me, "town.redeploy")) throw forbidden("town.redeploy");
  const run = world.host.redeploy;
  if (!run) throw new AppError("unreachable", "Redeploy is unavailable: the runtime is not running on the host.");
  return run({ image: input.image, requestedBy: me.name });
}
