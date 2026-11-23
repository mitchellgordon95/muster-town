/**
 * The Machine's memory from /proc/meminfo (grant gr_xgr8j2f9ao): available memory and swap, in MiB. The 2026-11-22
 * 18:25Z redeploy froze the 2 GB town Machine 11 s into `build web` with no swap (dc_7lp8owphy8); these figures go on
 * `GET /api/health` (`load.memAvailableMb`, `load.swapMb`), on every redeploy step event and into the monitor's
 * `memory` key, so the next memory incident leaves evidence.
 */
import { readFileSync } from "node:fs";

/** Available memory and swap in MiB (rounded). `swapTotalMb` 0 = no swap configured. */
export interface MemInfo { memAvailableMb: number; swapTotalMb: number; swapFreeMb: number }

/** Pure: /proc/meminfo's text (`MemAvailable:  123456 kB` lines) → MiB figures; null when MemAvailable is missing. Swap lines missing read 0. */
export function parseMeminfo(text: string): MemInfo | null {
  const kb = new Map<string, number>();
  for (const line of text.split("\n")) {
    const m = /^(\w+):\s+(\d+)\s*kB\s*$/.exec(line.trim());
    if (m) kb.set(m[1]!, Number(m[2]));
  }
  const avail = kb.get("MemAvailable");
  if (avail === undefined) return null;
  const mb = (k: number | undefined) => Math.round((k ?? 0) / 1024);
  return { memAvailableMb: mb(avail), swapTotalMb: mb(kb.get("SwapTotal")), swapFreeMb: mb(kb.get("SwapFree")) };
}

/** The live Machine's figures; null off Linux or when /proc/meminfo can't be read. */
export function readMeminfo(): MemInfo | null {
  if (process.platform !== "linux") return null;
  try { return parseMeminfo(readFileSync("/proc/meminfo", "utf8")); } catch { return null; }
}
