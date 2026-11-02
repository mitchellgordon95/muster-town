/**
 * Throwaway mode for drill towns (deploy/README.md "Recover", "Drill"): `MUSTER_TOWN_RUNTIME=off`. A town restored from a copy of
 * town.db carries the Bank's subscription token and API keys, so a drill app that started the runtime would run manage, explore,
 * schedule and meeting sessions on Mitchell's subscription, and its backup job would write to the live bucket. With the var set the
 * server starts no runtime (no sessions, no desks, no hourly export, no hosted runtimes) and the backup job is restore-only: the
 * first-boot restore (backup/restore.ts) still runs, no copy is ever uploaded or pruned. Unset (muster.town), nothing changes.
 */

/** `MUSTER_TOWN_RUNTIME`: "off" = throwaway; unset or "on" = the normal town. Anything else throws, so a typo never starts sessions. */
export function runtimeOff(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  if (!v || v === "on") return false;
  if (v === "off") return true;
  throw new Error(`MUSTER_TOWN_RUNTIME must be "on" or "off", not "${raw}"`);
}

/** Starts the runtime unless the town is a throwaway; returns what `start` returned, or null when off. */
export async function startRuntimeUnlessOff<T>(off: boolean, start: () => Promise<T>, log: Pick<Console, "log"> = console): Promise<T | null> {
  if (off) {
    log.log("[server] runtime off (throwaway): no sessions, no desks, no schedules, no hourly export; the backup is restore-only");
    return null;
  }
  return start();
}
