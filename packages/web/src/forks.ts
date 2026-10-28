/**
 * Manager forks on the web (design note dc_mymt27yz25 §3, §6): a fork ("Pix 3", forkOf = the manager) is drawn as a
 * ghost of the manager tinted with its building's colour, and named with a hover "fork of Pix · as_… · session se_…".
 */
import type { Agent } from "@muster-town/schema";

/** A stable pale tint per building (no building colour is stored): a hue hashed from its id. */
export function buildingTint(buildingId: string | null | undefined, alpha = 0.9): string {
  let h = 0;
  for (const c of buildingId ?? "") h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsla(${h % 360}, 80%, 82%, ${alpha})`;
}

export const isFork = (a: Pick<Agent, "forkOf"> | null | undefined): boolean => !!a?.forkOf;

/** The manager's name a fork's label shows, with its n as a subscript: "Pix 3" → { base: "Pix", n: 3 }. */
export function forkLabel(a: Pick<Agent, "name" | "forkN">): { base: string; n: number | null } {
  if (!a.forkN) return { base: a.name, n: null };
  const suffix = ` ${a.forkN}`;
  return { base: a.name.endsWith(suffix) ? a.name.slice(0, -suffix.length) : a.name, n: a.forkN };
}

/** The hover on a fork's name: "fork of Pix · as_… · session se_…" (parts it doesn't know are left out); "" for a named agent. */
export function forkTip(a: Pick<Agent, "forkOf"> | null | undefined, nameOf: (id: string) => string, assignmentId?: string | null, sessionId?: string | null): string {
  if (!a?.forkOf) return "";
  return [`fork of ${nameOf(a.forkOf)}`, assignmentId, sessionId ? `session ${sessionId}` : null].filter(Boolean).join(" · ");
}

/** The ghost's opacity: 0.6 (offline is 0.4, stopped 0.55), faded in over 400 ms from its first frame on the map. */
export const GHOST_ALPHA = 0.6;
export const GHOST_FADE_MS = 400;
export function ghostAlpha(sinceMs: number): number {
  return GHOST_ALPHA * Math.max(0, Math.min(1, sinceMs / GHOST_FADE_MS));
}
