/**
 * A collective that has never run (gr_a6512x0je1): a hosted one whose founder hasn't added a key, so no agent session ever
 * ran there (`health.started === false`, core world.ts `hasRun`). Its guest card and first-minute card stop promising
 * activity ("click any agent to see what they're doing") and point the visitor at a collective that is working, picked
 * from the root `GET /api/collectives` (the first one that has run and isn't this page's). The Workshop never shows it
 * (`health.started` is hosted-only).
 */
import { useEffect, useState } from "react";
import type { Collective, TownHealth } from "@muster-town/schema";
import { WEB_ROOT } from "./api";

/** Where a visitor is sent instead: a collective's name and the URL of its town. */
export interface WorkingCollective { name: string; url: string }

/** True only on a hosted collective that has never run an agent session. */
export function notStarted(health: Pick<TownHealth, "started"> | null): boolean {
  return health?.started === false;
}

/** Why it hasn't started, after "This collective hasn't started:" (the homepage tile says the same under its name). */
export function notStartedWhy(health: Pick<TownHealth, "funding"> | null): string {
  return health?.funding === "none" ? "its founder hasn't added a key yet." : "no agent has worked here yet.";
}

/** The first listed collective that has run and isn't this page's own (`self`, e.g. `/trauma/`); null when none has. */
export function workingCollective(list: readonly Pick<Collective, "name" | "url" | "started" | "placeholder">[], self: string): WorkingCollective | null {
  const c = list.find((x) => x.started && !x.placeholder && x.url && x.url !== self);
  return c ? { name: c.name, url: c.url } : null;
}

/** Fetches the root list once while `enabled` (a never-run collective) and names the collective to watch instead. */
export function useWorkingCollective(enabled: boolean): WorkingCollective | null {
  const [found, setFound] = useState<WorkingCollective | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    fetch("/api/collectives").then((r) => r.ok ? r.json() : null).then((body: { collectives?: Collective[] } | null) => {
      if (live && body?.collectives) setFound(workingCollective(body.collectives, WEB_ROOT));
    }).catch(() => {});
    return () => { live = false; };
  }, [enabled]);
  return enabled ? found : null;
}
