/**
 * The daily funding reconciliation's runtime half (post-mortem 2026-10-30; core `reconcile.ts` is the check): once per
 * UTC day, for the day before, run `reconcileFunding`, which checks the Bank against its own session records, logs
 * the result and raises the alert. Nothing here calls out of the town: no Console, no Admin API, no secret.
 */
import { previousUtcDay, reconciled, reconcileFunding, type ReconcileResult } from "@muster-town/core";
import type { Ctx } from "./session.ts";

const inFlight = new Set<string>();

/**
 * Run the day before's reconciliation once (the runtime calls this every tick). Nothing to do when it already ran, or
 * when that day had no sessions (a fresh town stays quiet).
 */
export async function reconcileDue(ctx: Ctx, now: Date): Promise<ReconcileResult | null> {
  const { world } = ctx;
  const day = previousUtcDay(now);
  if (inFlight.has(day) || reconciled(world, day)) return null;
  if (!world.sessions.count("status != 'running' AND endedAt >= ? AND endedAt < ?", [`${day}T00:00:00.000Z`, `${now.toISOString().slice(0, 10)}T00:00:00.000Z`])) return null;
  inFlight.add(day);
  try {
    return reconcileFunding(world, day);
  } finally {
    inFlight.delete(day);
  }
}
