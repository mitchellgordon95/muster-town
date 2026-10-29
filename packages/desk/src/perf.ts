/**
 * Desk session performance (grant gr_uhh6u39vv9 step 1): the Machine's CPU and steal time over a session, from the
 * aggregate `cpu` line of /proc/stat (`cpu  user nice system idle iowait irq softirq steal guest guest_nice`, in jiffies).
 * A jiffy is 1/USER_HZ s; USER_HZ is 100 on every Linux the desks run (x86_64 and arm64 kernels fix it at 100), so we
 * assume 10 ms rather than shell out to `getconf CLK_TCK`.
 */
import { readFileSync } from "node:fs";

const MS_PER_JIFFY = 10;

/** CPU (user+nice+system) and steal jiffies from /proc/stat's text, or null when its first line isn't the cpu total. */
export function parseProcStat(text: string): { cpu: number; steal: number } | null {
  const first = text.split("\n", 1)[0] ?? "";
  const f = first.trim().split(/\s+/);
  if (f[0] !== "cpu" || f.length < 9) return null;
  const n = f.slice(1, 9).map(Number);
  if (n.some((x) => !Number.isFinite(x))) return null;
  return { cpu: n[0]! + n[1]! + n[2]!, steal: n[7]! };
}

/** The current reading, or null when /proc/stat is unreadable (best effort: the session then posts wallMs only). */
export function readProcStat(path = "/proc/stat"): { cpu: number; steal: number } | null {
  try {
    return parseProcStat(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** One session's measurement: start it at session start, `finish()` just before session-end. */
export function startPerf(read: () => { cpu: number; steal: number } | null = readProcStat, now: () => number = Date.now) {
  const t0 = now(), s0 = read();
  return {
    finish(): { wallMs: number; cpuMs?: number; stealMs?: number } {
      const wallMs = Math.max(0, Math.round(now() - t0));
      const s1 = s0 ? read() : null;
      if (!s0 || !s1) return { wallMs };
      return { wallMs, cpuMs: Math.max(0, s1.cpu - s0.cpu) * MS_PER_JIFFY, stealMs: Math.max(0, s1.steal - s0.steal) * MS_PER_JIFFY };
    },
  };
}
