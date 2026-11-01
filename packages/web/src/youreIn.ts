/**
 * The one-time "You're in" card (gr_58n37j410s step 2, kr_xqbhxxptf3): a member let in while away saw nothing say so,
 * because the live toast only fires while the page is open. The card shows when the signed-in user's latest access
 * request is granted and this browser hasn't dismissed that grant yet: one localStorage key per decision
 * (`musterTown.youreIn.<decidedAt>`), so a later re-grant shows it again.
 */
import type { AuthMe, SnapshotBuilding } from "@muster-town/schema";

export const youreInKey = (decidedAt: string): string => `musterTown.youreIn.${decidedAt}`;

type Store = Pick<Storage, "getItem">;

/** The storage key of the grant to welcome, or null when there is nothing to show (no grant, or dismissed already). */
export function youreInDue(me: AuthMe | null, storage: Store | null): string | null {
  const req = me?.accessRequest;
  if (!me || me.canInteract === false || req?.status !== "granted" || !req.decidedAt) return null;
  const key = youreInKey(req.decidedAt);
  try { return storage?.getItem(key) ? null : key; } catch { return key; }
}

/** "Mitchell let you join Workshop Collective." by the decider's name; one named admin stands in for an older server; else "An admin let you join." */
export function youreInLine(me: AuthMe, collective: string): string {
  const req = me.accessRequest;
  const who = req?.decidedByName ?? (req?.deciders.length === 1 ? req.deciders[0] : null);
  return who ? `${who} let you join ${collective}.` : "An admin let you join.";
}

/** The first building with a manager that isn't the Town Hall (the Workshop here): the card's "Talk to ★" goes to them. */
export function firstManagerBuilding(buildings: SnapshotBuilding[]): SnapshotBuilding | null {
  return buildings.find((b) => b.kind !== "town-hall" && !!b.managerAgentId) ?? null;
}
