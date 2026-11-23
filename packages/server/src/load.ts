import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { readMeminfo, type MemInfo } from "@muster-town/core";

/** Read-only load figures for `GET /api/health` (`load`): event-loop lag, resident memory, open WebSocket clients, the Machine's available memory and swap. */
interface LoadSnapshot {
  /** p99 event-loop delay over the last completed 10 s window (ms, sampling interval subtracted: idle reads 0); 0 until a window has closed */
  lagMs: number;
  /** process RSS in MiB */
  rssMb: number;
  /** `/ws` sockets open right now */
  wsClients: number;
  /** the Machine's MemAvailable in MiB (/proc/meminfo); null off Linux (grant gr_xgr8j2f9ao) */
  memAvailableMb: number | null;
  /** swap configured on the Machine in MiB (0 = none); null off Linux */
  swapMb: number | null;
  /** swap in use in MiB; null off Linux */
  swapUsedMb: number | null;
}

/** Windows of this length: a stall shows for at least one window after it happened. */
const WINDOW_MS = 10_000;
/** Sampling interval: the histogram's values include it (an idle loop reads about RESOLUTION_MS), so it is subtracted. */
const RESOLUTION_MS = 20;

/**
 * Samples the event loop with `monitorEventLoopDelay` and counts WebSocket clients (ws.ts calls `clientOpened` /
 * `clientClosed`). The timer is unref'd, so it never keeps the process alive.
 */
export class LoadMonitor {
  private histogram: IntervalHistogram;
  private lastP99Ms = 0;
  private clients = 0;
  private timer: NodeJS.Timeout;

  constructor(windowMs = WINDOW_MS, private readonly meminfo: () => MemInfo | null = readMeminfo) {
    this.histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    this.histogram.enable();
    this.timer = setInterval(() => {
      // percentile() is in nanoseconds; the histogram has no samples until the first resolution tick
      this.lastP99Ms = this.histogram.count > 0 ? Math.max(0, Math.round(this.histogram.percentile(99) / 1e6) - RESOLUTION_MS) : 0;
      this.histogram.reset();
    }, windowMs);
    this.timer.unref();
  }

  clientOpened() { this.clients += 1; }
  clientClosed() { this.clients = Math.max(0, this.clients - 1); }

  snapshot(): LoadSnapshot {
    const m = this.meminfo();
    return { lagMs: this.lastP99Ms, rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)), wsClients: this.clients,
      memAvailableMb: m?.memAvailableMb ?? null, swapMb: m?.swapTotalMb ?? null, swapUsedMb: m ? Math.max(0, m.swapTotalMb - m.swapFreeMb) : null };
  }

  close() {
    clearInterval(this.timer);
    this.histogram.disable();
  }
}
