const HOUR_MS = 3600_000;

/** In-memory sliding window per key: `hit` is false once the key has `limit` hits in the last hour. */
export class RateLimit {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly now: () => number) {}
  hit(key: string): boolean {
    const t = this.now(), recent = (this.hits.get(key) ?? []).filter((x) => t - x < HOUR_MS);
    if (this.hits.size > 10_000) this.hits.clear();
    if (recent.length >= this.limit) { this.hits.set(key, recent); return false; }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }
}
