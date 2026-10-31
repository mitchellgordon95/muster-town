import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

/** Read-only load figures for `GET /api/health` (`load`): event-loop lag, resident memory, open WebSocket clients. */
interface LoadSnapshot {
  /** p99 event-loop delay over the last completed 10 s window (ms, sampling interval subtracted: idle reads 0); 0 until a window has closed */
  lagMs: number;
  /** process RSS in MiB */
  rssMb: number;
  /** `/ws` sockets open right now */
  wsClients: number;
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

  constructor(windowMs = WINDOW_MS) {
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
    return { lagMs: this.lastP99Ms, rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)), wsClients: this.clients };
  }

  close() {
    clearInterval(this.timer);
    this.histogram.disable();
  }
}
