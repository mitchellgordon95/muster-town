/**
 * "Let in" and "Let in + direct work under <goal>" (grant gr_cuobjlny6r, Mitchell mt_hlizi9wxxc decision 1): the Town Hall
 * in-tray's AccessRow and the admin's HUD notice offer both. The goal is /api/me `directDefaultGoalId` (the decider's
 * captained goal, else the town goal for an admin); its text comes from /api/me `direct` or the goal's plaza on the map.
 */
import { api } from "../api";
import { goalShortName } from "../purpose";
import { store } from "../state";

/** The goal the second button offers, with its full and short text; null = the decider can't grant one. */
export function letInGoal(): { id: string; text: string; short: string } | null {
  const me = store.state.me;
  const id = me?.directDefaultGoalId;
  if (!id) return null;
  const text = me.direct?.find((d) => d.goalId === id)?.text ?? store.state.places.find((p) => p.id === `plaza:${id}`)?.name ?? id;
  return { id, text, short: goalShortName(text) };
}

/** Decide a request: decline, let in, or let in with "direct work under" the goal. Toasts what happened. */
export async function decideJoin(req: { id: string; githubLogin: string | null; name: string }, grant: boolean, goal?: { id: string; short: string } | null): Promise<void> {
  const who = req.githubLogin ? `@${req.githubLogin}` : req.name;
  await api().decideAccess(req.id, grant, grant ? goal?.id ?? null : null);
  store.toast(!grant ? `Declined ${who}. They can ask again tomorrow.`
    : goal ? `${who} is in and may direct work under "${goal.short}": they can talk to its managers in a 1:1.`
    : `${who} is in: they can now move, message agents and write.`, "ok");
}
