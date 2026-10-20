/** Accounting pools in the UI: one colour per pool, shared by the Bank panel and the Bank's town map. */
import type { Bank } from "./api";

/** General is the Bank's gold; the others get distinct hues that read on the dark map. */
export const POOL_COLORS = ["#f2c94c", "#4fd1c5", "#b794f4", "#f6855e", "#63b3ed", "#9ae66e", "#f687b3", "#e2e8f0"];

/** A pool's colour by its place in the summary (General first, then by creation), cycling past eight. */
export function poolColor(bank: Pick<Bank, "pools"> | null, poolId: string): string {
  const i = bank?.pools.findIndex((p) => p.id === poolId) ?? -1;
  return POOL_COLORS[Math.max(0, i) % POOL_COLORS.length];
}

/** "12%" or "12.5%" */
export const fmtPct = (pct: number) => `${pct % 1 ? pct.toFixed(1) : pct}%`;
