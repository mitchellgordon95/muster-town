/**
 * A hosted collective's founder after the key (gr_ngg1z160a8 step 3, kr_mw367chfbp): between pasting a key and the first
 * funded grant the HUD names the next thing. While an exploration runs and nothing is proposed: "Your agents are exploring
 * <goal>"; once a proposal is open: "Your first proposal is waiting"; nothing once any grant has been funded. Only on a
 * hosted collective (`health.founder` is hosted-only, so the Workshop never shows it) and only to its admin (the founder).
 */
import type { Event, TownHealth } from "@muster-town/schema";

type FounderStep = { kind: "exploring"; since: string; agentId: string | null } | { kind: "proposal"; count: number } | null;

export function founderStep(health: TownHealth | null, isAdmin: boolean, events: readonly Event[] = []): FounderStep {
  const f = health?.founder;
  if (!isAdmin || !f || health?.funding !== "api-key" || f.funded) return null;
  if (f.proposals > 0) return { kind: "proposal", count: f.proposals };
  if (!f.exploringSince) return null;
  // who is exploring: the latest exploration.started still in the client's window (the notice opens them)
  let agentId: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) if (events[i].type === "exploration.started") { agentId = events[i].agentId; break; }
  return { kind: "exploring", since: f.exploringSince, agentId };
}

/** Events after which a hosted collective's `funding` / `founder` may have moved: the HUD refetches /api/health. */
export function founderStale(e: Pick<Event, "type">): boolean {
  return e.type === "exploration.started" || e.type === "bank.input" || e.type === "grant.proposed" || e.type === "grant.countered"
    || e.type === "grant.funded" || e.type === "grant.rejected";
}
