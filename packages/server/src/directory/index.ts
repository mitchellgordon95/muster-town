/**
 * The self-hosted towns directory (grant gr_8cdix9mpye, design dc_d6chojzl2a): strangers register a DNS name with
 * muster.town, prove control (TXT or `/.well-known/muster-town`), and verified towns seen in the last 24 h are listed.
 * Step 1: register + list. Step 2 adds verify, the checker, admin removal and the health section.
 * Rows live in `directory_towns` (migration 059) in the town's own db, so the nightly backup covers them.
 * Only built where MUSTER_TOWN_DIRECTORY=on (main.ts); the clock is injectable for tests (the Monitor pattern).
 */
import { AppError, type World } from "@muster-town/core";
import type { DirectoryTown } from "@muster-town/schema";
import { randomBytes } from "node:crypto";
import { normalizeHost } from "./net.ts";

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
export const LIMITS = { registerPerIpPerDay: 10, pendingPerIp: 5, newPerDay: 200, maxVerified: 500, maxPending: 200 };

export interface DirectoryOptions {
  world: World;
  now?: () => number;
  /** the header the client IP comes from (`fly-client-ip` behind Fly's proxy, which overwrites it); else the socket address */
  clientIpHeader?: string | null;
}

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

  constructor(opts: DirectoryOptions) {
    this.world = opts.world;
    this.now = opts.now ?? Date.now;
    this.clientIpHeader = opts.clientIpHeader?.toLowerCase() ?? null;
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
