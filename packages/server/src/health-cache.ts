/**
 * The database-backed part of `GET /api/health` (503 post-mortem 2026-10-31, follow-up A): budgets, desks, backup,
 * directory and a hosted collective's funding come from SQLite. With `refreshMs` > 0 (main.ts: 5 s) a timer recomputes
 * them and the route serves the last copy, so a health request never queries the database and answers as long as the
 * event loop does. With 0 (tests) each request computes them, as before. A failed refresh keeps the last good copy.
 */
export class HealthCache<T extends object> {
  private value: T | null = null;
  private at: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly compute: () => T, private readonly refreshMs: number, private readonly onError: (e: unknown) => void = () => {}) {
    if (refreshMs > 0) {
      this.timer = setInterval(() => this.refresh(), refreshMs);
      this.timer.unref();
    }
  }

  private refresh(): void {
    try {
      this.value = this.compute();
      this.at = Date.now();
    } catch (e) {
      this.onError(e);
    }
  }

  /** the figures and when they were computed (ISO); the first call computes them once */
  get(): { figures: T; at: string } {
    if (this.refreshMs <= 0 || this.value === null) this.refresh();
    if (this.value === null) this.value = this.compute(); // the first computation failed: let the route answer 500 honestly
    return { figures: this.value, at: new Date(this.at ?? Date.now()).toISOString() };
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
