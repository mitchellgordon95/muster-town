/**
 * The self-hosted towns directory (grant gr_8cdix9mpye, design dc_d6chojzl2a): strangers register a DNS name with
 * muster.town, prove control (TXT or `/.well-known/muster-town`), and verified towns seen in the last 24 h are listed.
 * Step 1: register + list. Step 2: check (TXT, then well-known, then the town's health + collectives), verify, the checker
 * (`start()`: pending schedule, hourly re-check, two-miss delist, 7-day expiry), admin removal + block list, the health section.
 * Rows live in `directory_towns` (migration 059) in the town's own db, so the hourly backup covers them.
 * Only built where MUSTER_TOWN_DIRECTORY=on (main.ts); the clock is injectable for tests (the Monitor pattern).
 */
import { AppError, type World } from "@muster-town/core";
import type { DirectoryTown } from "@muster-town/schema";
import { randomBytes } from "node:crypto";
import { defaultTxtResolver, type Fetcher, normalizeHost, resolveTxtProof, safeGet, type TxtResolver } from "./net.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** listed only if seen within this window */
export const SEEN_WINDOW_MS = DAY;
/** a pending row older than this is replaced with a fresh token on register (step 2's checker deletes it) */
export const PENDING_TTL_MS = 7 * DAY;
/** the list query is memoized this long */
export const LIST_CACHE_MS = MIN;
/** in-memory and per process (one Machine; a restart resets them, which is acceptable) */
export const LIMITS = { registerPerIpPerDay: 10, pendingPerIp: 5, newPerDay: 200, maxVerified: 500, maxPending: 200, verifyPerIpPerHour: 30 };
/** a pending row is checked at these offsets from createdAt, then daily */
export const PENDING_SCHEDULE_MS = [MIN, 5 * MIN, 15 * MIN, HOUR, 6 * HOUR];
/** verified rows are re-checked every hour ± this */
export const RECHECK_JITTER_MS = 10 * MIN;
/** a verified row unseen this long is deleted (it can register again) */
export const UNSEEN_TTL_MS = 7 * DAY;
/** POST /verify runs at most one check per host in this window (later calls get the last result) */
export const VERIFY_WINDOW_MS = MIN;
export const TICK_MS = 5 * MIN;
export const TICK_ROWS = 20;
export const TICK_CONCURRENCY = 4;
const FETCH = { timeoutMs: 5000 };

/**
 * Whether this town runs the directory: MUSTER_TOWN_DIRECTORY=on|off decides; unset, it is on only where MUSTER_TOWN_PUBLIC_URL is
 * muster.town (an [env] change in fly.town.toml reaches the Machine only with an image deploy; the town's redeploy is code only).
 */
export function directoryEnabled(flag: string | undefined, publicUrl: string | undefined): boolean {
  const f = flag?.trim().toLowerCase();
  if (f) return f === "on";
  try {
    return publicUrl ? new URL(publicUrl).hostname.toLowerCase() === "muster.town" : false;
  } catch {
    return false;
  }
}

export interface DirectoryOptions {
  world: World;
  now?: () => number;
  /** the header the client IP comes from (`fly-client-ip` behind Fly's proxy, which overwrites it); else the socket address */
  clientIpHeader?: string | null;
  /** tests: fake DNS TXT and HTTPS (default: the real resolver and safeGet) */
  resolveTxt?: TxtResolver;
  fetch?: Fetcher;
  /** tests: the jitter source, 0..1 (default Math.random) */
  random?: () => number;
}

export interface CheckResult {
  host: string;
  status: "pending" | "verified";
  proof: "txt" | "well-known" | null;
  verifiedAt: string | null;
  lastSeenAt: string | null;
  lastError: string | null;
}

export interface DirectoryView { verified: number; listed: number; pending: number; lastTickAt: string | null }

export interface Registration {
  host: string;
  token: string;
  status: "pending" | "verified";
  instructions: {
    txt: { name: string; value: string };
    wellKnown: { url: string; body: string; env: string };
    then: string;
  };
}

interface Row { host: string; token: string; createdAt: string; verifiedAt: string | null; lastSeenAt: string | null; name: string; goal: string }
interface FullRow extends Row { proof: "txt" | "well-known" | null; proofMisses: number; lastCheckAt: string | null; nextCheckAt: string; lastError: string | null }

const iso = (ms: number) => new Date(ms).toISOString();
/** a stranger's text shown on muster.town: control characters out, whitespace collapsed, length-capped (the tile escapes HTML) */
export function cleanText(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** `mtd_` + 26 lowercase base32 chars (RFC 4648 alphabet) from 16 random bytes: 128 bits. */
export function newToken(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = randomBytes(16);
  let bits = 0, acc = 0, out = "";
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { out += alphabet[(acc >>> (bits - 5)) & 31]; bits -= 5; }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += alphabet[(acc << (5 - bits)) & 31];
  return "mtd_" + out;
}

export class Directory {
  readonly now: () => number;
  readonly clientIpHeader: string | null;
  private readonly world: World;
  private registers = new Map<string, number[]>();
  private cache: { at: number; towns: DirectoryTown[] } | null = null;
  private readonly resolveTxt: TxtResolver;
  private readonly fetch: Fetcher;
  private readonly random: () => number;
  private verifies = new Map<string, number[]>();
  private lastVerify = new Map<string, { at: number; result: Promise<CheckResult> }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private lastTickAt: number | null = null;

  constructor(opts: DirectoryOptions) {
    this.world = opts.world;
    this.now = opts.now ?? Date.now;
    this.clientIpHeader = opts.clientIpHeader?.toLowerCase() ?? null;
    this.resolveTxt = opts.resolveTxt ?? defaultTxtResolver();
    this.fetch = opts.fetch ?? safeGet;
    this.random = opts.random ?? Math.random;
  }

  /**
   * Register a host: the same token for every asker (it's public: publishing it is the proof). `created` = a new row (201).
   * Refuses bad and blocked hosts (400) and, past the caps, 429 rate_limited.
   */
  register(input: string, ip: string): { created: boolean; registration: Registration } {
    const n = normalizeHost(input);
    if ("error" in n) throw new AppError("bad_request", n.error);
    const host = n.host;
    const db = this.world.db;
    if (db.prepare("SELECT 1 FROM directory_blocked WHERE host = ?").get(host)) throw new AppError("forbidden", `${host} can't be listed by this directory.`);
    const now = this.now();
    this.limitIp(ip, now);
    const row = db.prepare("SELECT * FROM directory_towns WHERE host = ?").get(host) as Row | undefined;
    const stale = row && !row.verifiedAt && Date.parse(row.createdAt) <= now - PENDING_TTL_MS;
    if (row && !stale) return { created: false, registration: this.registration(row) };
    this.limitRows(ip, now);
    const iso = new Date(now).toISOString();
    const token = newToken();
    db.prepare(`INSERT INTO directory_towns (host, token, createdAt, createdIp, nextCheckAt) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(host) DO UPDATE SET token = excluded.token, createdAt = excluded.createdAt, createdIp = excluded.createdIp,
        nextCheckAt = excluded.nextCheckAt, proof = NULL, proofMisses = 0, lastCheckAt = NULL, lastError = NULL`)
      .run(host, token, iso, ip, new Date(now + MIN).toISOString());
    return { created: !row, registration: this.registration({ host, token, createdAt: iso, verifiedAt: null, lastSeenAt: null, name: "", goal: "" }) };
  }

  /** Verified towns seen in the last 24 h, not blocked, oldest verification first (stable tiles). Memoized 60 s. */
  list(): DirectoryTown[] {
    const now = this.now();
    if (this.cache && now - this.cache.at < LIST_CACHE_MS) return this.cache.towns;
    const rows = this.world.db.prepare(`SELECT t.* FROM directory_towns t
      WHERE t.verifiedAt IS NOT NULL AND t.lastSeenAt IS NOT NULL AND t.lastSeenAt >= ?
        AND NOT EXISTS (SELECT 1 FROM directory_blocked b WHERE b.host = t.host)
      ORDER BY t.verifiedAt, t.host`).all(new Date(now - SEEN_WINDOW_MS).toISOString()) as Row[];
    const towns = rows.map((r) => ({ host: r.host, url: `https://${r.host}/`, name: r.name, goal: r.goal, verifiedAt: r.verifiedAt!, lastSeenAt: r.lastSeenAt! }));
    this.cache = { at: now, towns };
    return towns;
  }

  /**
   * One check of a registered host (design §2-3): the TXT proof, else the well-known one; on a pass, the town's /api/health and
   * /api/collectives. First pass sets verifiedAt (and lastSeenAt + name/goal if the town answered). A verified row whose proof is gone
   * counts a miss; the second consecutive miss at least 1 h after the first delists it (back to pending, same token).
   * A DNS error that isn't "no record" is "couldn't check": no miss. Returns null for an unknown host.
   */
  async check(host: string): Promise<CheckResult | null> {
    const db = this.world.db;
    const row = db.prepare("SELECT * FROM directory_towns WHERE host = ?").get(host) as FullRow | undefined;
    if (!row) return null;
    const proof = await this.proof(row);
    const now = this.now();
    const cur = db.prepare("SELECT * FROM directory_towns WHERE host = ?").get(host) as FullRow | undefined;
    if (!cur || cur.token !== row.token) return cur ? this.result(cur) : null;
    let next: Partial<FullRow>;
    if (proof.pass) {
      const town = await this.town(host);
      next = { proof: proof.pass, verifiedAt: cur.verifiedAt ?? iso(this.now()), proofMisses: 0, nextCheckAt: this.recheckAt(now), lastError: "error" in town ? town.error : null };
      if (!("error" in town)) Object.assign(next, { lastSeenAt: iso(this.now()), name: town.name, goal: town.goal });
    } else if (proof.unknown) {
      next = { lastError: proof.error, nextCheckAt: cur.verifiedAt ? this.recheckAt(now) : this.pendingAt(cur, now) };
    } else if (cur.verifiedAt) {
      const since = cur.lastCheckAt ? now - Date.parse(cur.lastCheckAt) : Infinity;
      if (cur.proofMisses >= 1 && since >= HOUR) {
        // the second miss, at least an hour after the first: delisted, pending again with a fresh 7 days and the same token
        next = { verifiedAt: null, proof: null, proofMisses: 0, createdAt: iso(now), lastError: `proof gone twice: ${proof.error}` };
        next.nextCheckAt = this.pendingAt({ createdAt: iso(now) }, now);
      } else if (cur.proofMisses >= 1) {
        // a second miss too soon after the first (a /verify call): note it, keep the first miss's time
        this.update(host, { lastError: `proof missing: ${proof.error}` });
        return this.result({ ...cur, lastError: `proof missing: ${proof.error}` });
      } else {
        next = { proofMisses: 1, nextCheckAt: iso(now + HOUR), lastError: `proof missing: ${proof.error}` };
      }
    } else {
      next = { lastError: proof.error, nextCheckAt: this.pendingAt(cur, now) };
    }
    next.lastCheckAt = iso(now);
    this.update(host, next);
    this.cache = null;
    return this.result({ ...cur, ...next } as FullRow);
  }

  /**
   * POST /api/directory/verify: one check now, at most one per host per 60 s (later calls get the last result), 30 per IP per hour.
   * 404 for a host that isn't registered.
   */
  async verify(input: string, ip: string): Promise<CheckResult> {
    const n = normalizeHost(input);
    if ("error" in n) throw new AppError("bad_request", n.error);
    const host = n.host;
    const now = this.now();
    const last = this.lastVerify.get(host);
    if (last && now - last.at < VERIFY_WINDOW_MS) return last.result;
    if (!this.world.db.prepare("SELECT 1 FROM directory_towns WHERE host = ?").get(host)) throw new AppError("not_found", `${host} isn't registered: POST /api/directory/register first.`);
    const recent = (this.verifies.get(ip) ?? []).filter((t) => t > now - HOUR);
    if (recent.length >= LIMITS.verifyPerIpPerHour) throw new AppError("rate_limited", "Too many verify calls from this address; try again in an hour.");
    recent.push(now);
    this.verifies.set(ip, recent);
    if (this.verifies.size > 10_000) for (const [k, v] of this.verifies) if (!v.some((t) => t > now - HOUR)) this.verifies.delete(k);
    for (const [k, v] of this.lastVerify) if (now - v.at >= VERIFY_WINDOW_MS) this.lastVerify.delete(k);
    const result = this.check(host).then((r) => {
      if (!r) throw new AppError("not_found", `${host} isn't registered: POST /api/directory/register first.`);
      return r;
    });
    this.lastVerify.set(host, { at: now, result });
    result.catch(() => this.lastVerify.delete(host));
    return result;
  }

  /** Admin removal: the row goes and the host is blocked from registering again. */
  remove(input: string, reason: string): { host: string; removed: boolean } {
    const n = normalizeHost(input);
    const host = "error" in n ? input.trim().toLowerCase() : n.host;
    const db = this.world.db;
    const removed = db.prepare("DELETE FROM directory_towns WHERE host = ?").run(host).changes > 0;
    db.prepare("INSERT INTO directory_blocked (host, reason, at) VALUES (?, ?, ?) ON CONFLICT(host) DO UPDATE SET reason = excluded.reason, at = excluded.at")
      .run(host, reason.trim().slice(0, 500) || "removed by an admin", iso(this.now()));
    this.lastVerify.delete(host);
    this.cache = null;
    return { host, removed };
  }

  /** One checker pass: expire old rows, then check up to 20 due rows, 4 at a time. The queue is nextCheckAt in the table. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      this.lastTickAt = now;
      const db = this.world.db;
      const pendingCut = iso(now - PENDING_TTL_MS), unseenCut = iso(now - UNSEEN_TTL_MS);
      const gone = db.prepare("DELETE FROM directory_towns WHERE verifiedAt IS NULL AND createdAt <= ?").run(pendingCut).changes
        + db.prepare("DELETE FROM directory_towns WHERE verifiedAt IS NOT NULL AND COALESCE(lastSeenAt, verifiedAt) <= ?").run(unseenCut).changes;
      if (gone) this.cache = null;
      const due = db.prepare("SELECT host FROM directory_towns WHERE nextCheckAt <= ? ORDER BY nextCheckAt LIMIT ?").all(iso(now), TICK_ROWS) as { host: string }[];
      const queue = due.map((r) => r.host);
      const worker = async () => {
        for (let h = queue.shift(); h; h = queue.shift()) {
          try { await this.check(h); } catch (e) { console.warn(`[directory] check ${h} failed: ${e instanceof Error ? e.message : String(e)}`); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(TICK_CONCURRENCY, queue.length) }, worker));
    } finally {
      this.ticking = false;
    }
  }

  start(intervalMs = TICK_MS): void {
    if (this.timer) return;
    const run = () => { this.tick().catch((e) => console.warn(`[directory] tick failed: ${e instanceof Error ? e.message : String(e)}`)); };
    this.timer = setInterval(run, intervalMs);
    this.timer.unref();
    setTimeout(run, 15_000).unref();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** `GET /api/health` `directory`: verified rows, listed now, pending rows, the checker's last tick. */
  view(): DirectoryView {
    const c = this.world.db.prepare("SELECT SUM(verifiedAt IS NOT NULL) AS v, SUM(verifiedAt IS NULL) AS p FROM directory_towns").get() as { v: number | null; p: number | null };
    return { verified: c.v ?? 0, listed: this.list().length, pending: c.p ?? 0, lastTickAt: this.lastTickAt === null ? null : iso(this.lastTickAt) };
  }

  private async proof(row: FullRow): Promise<{ pass: "txt" | "well-known" | null; unknown: boolean; error: string }> {
    const txt = await resolveTxtProof(row.host, row.token, this.resolveTxt);
    if (txt.result === "pass") return { pass: "txt", unknown: false, error: "" };
    const url = `https://${row.host}/.well-known/muster-town`;
    let wk: string;
    try {
      const r = await this.fetch(url, { ...FETCH, maxBytes: 1024 });
      const body = r.body.trim();
      if (r.status === 200 && (body === row.token || body.includes(`muster-town-verify=${row.token}`))) return { pass: "well-known", unknown: false, error: "" };
      wk = r.status === 200 ? `${url} doesn't carry the token` : `${url} answered ${r.status}`;
    } catch (e) {
      wk = `${url}: ${e instanceof Error ? e.message : String(e)}`;
    }
    // a DNS error that isn't "no record" means we couldn't tell: never a miss
    return { pass: null, unknown: txt.result === "error", error: `${txt.error}; ${wk}`.slice(0, 500) };
  }

  /** The town itself: /api/health ok === true, then /api/collectives element 0 for name and goal. */
  private async town(host: string): Promise<{ name: string; goal: string } | { error: string }> {
    const get = async (path: string): Promise<unknown> => {
      const r = await this.fetch(`https://${host}${path}`, { ...FETCH, maxBytes: 64 * 1024 });
      if (r.status !== 200) throw new Error(`${path} answered ${r.status}`);
      try { return JSON.parse(r.body); } catch { throw new Error(`${path} isn't JSON`); }
    };
    try {
      const health = await get("/api/health") as { ok?: unknown };
      if (health?.ok !== true) return { error: "/api/health isn't ok" };
      const c = await get("/api/collectives") as { collectives?: { name?: unknown; goal?: unknown }[] };
      const own = Array.isArray(c?.collectives) ? c.collectives[0] : undefined;
      if (!own) return { error: "/api/collectives has no town" };
      return { name: cleanText(own.name, 80), goal: cleanText(own.goal, 300) };
    } catch (e) {
      return { error: `the town didn't answer: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500) };
    }
  }

  /** The pending schedule: +1 min, +5 min, +15 min, +1 h, +6 h from createdAt, then daily. */
  private pendingAt(row: { createdAt: string }, now: number): string {
    const created = Date.parse(row.createdAt);
    const at = PENDING_SCHEDULE_MS.map((o) => created + o).find((t) => t > now);
    return iso(at ?? now + DAY);
  }

  private recheckAt(now: number): string { return iso(now + HOUR + Math.round((this.random() * 2 - 1) * RECHECK_JITTER_MS)); }

  private update(host: string, fields: Partial<FullRow>): void {
    const keys = Object.keys(fields) as (keyof FullRow)[];
    if (!keys.length) return;
    this.world.db.prepare(`UPDATE directory_towns SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE host = ?`).run(...keys.map((k) => fields[k] ?? null), host);
  }

  private result(r: FullRow): CheckResult {
    return { host: r.host, status: r.verifiedAt ? "verified" : "pending", proof: r.proof, verifiedAt: r.verifiedAt, lastSeenAt: r.lastSeenAt, lastError: r.lastError };
  }

  private registration(r: Row): Registration {
    return {
      host: r.host,
      token: r.token,
      status: r.verifiedAt ? "verified" : "pending",
      instructions: {
        txt: { name: `_muster-town.${r.host}`, value: `muster-town-verify=${r.token}` },
        wellKnown: { url: `https://${r.host}/.well-known/muster-town`, body: r.token, env: `MUSTER_TOWN_DIRECTORY_TOKEN=${r.token}` },
        then: "Publish one of the two proofs; muster.town checks it within 15 minutes and lists the town once it answers /api/health and /api/collectives.",
      },
    };
  }

  /** 10 register calls per IP per rolling day (repeats of an existing host count too). */
  private limitIp(ip: string, now: number): void {
    const recent = (this.registers.get(ip) ?? []).filter((t) => t > now - DAY);
    if (recent.length >= LIMITS.registerPerIpPerDay) throw new AppError("rate_limited", "Too many registrations from this address today; try again tomorrow.");
    recent.push(now);
    this.registers.set(ip, recent);
    if (this.registers.size > 10_000) for (const [k, v] of this.registers) if (!v.some((t) => t > now - DAY)) this.registers.delete(k);
  }

  /** Caps on new rows: 5 pending per IP, 200 new per day, 500 verified + 200 pending overall. */
  private limitRows(ip: string, now: number): void {
    const db = this.world.db;
    const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
    if (count("SELECT COUNT(*) AS n FROM directory_towns WHERE verifiedAt IS NULL AND createdIp = ?", ip) >= LIMITS.pendingPerIp)
      throw new AppError("rate_limited", `This address already has ${LIMITS.pendingPerIp} pending registrations; prove one first.`);
    if (count("SELECT COUNT(*) AS n FROM directory_towns WHERE createdAt >= ?", new Date(now - DAY).toISOString()) >= LIMITS.newPerDay
      || count("SELECT COUNT(*) AS n FROM directory_towns WHERE verifiedAt IS NULL") >= LIMITS.maxPending
      || count("SELECT COUNT(*) AS n FROM directory_towns WHERE verifiedAt IS NOT NULL") >= LIMITS.maxVerified)
      throw new AppError("rate_limited", "The directory is taking no new registrations right now; try again later.");
  }
}
