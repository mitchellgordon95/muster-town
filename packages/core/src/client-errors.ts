/**
 * Browser errors (grant gr_cyqzweu6ed step 1): a panel crash (React error boundary), an uncaught error or an unhandled
 * promise rejection in a browser on the live town, posted by the page (POST /api/client-errors) and kept one row per kind.
 * A kind is its signature: the normalized message (ids, numbers, hashes and URLs blanked) and the top stack frame (function
 * and file, the build hash and line:col dropped), so the same bug on two builds or two docs is one kind with a count.
 * Counts and commits only: no user id, IP, URL query or typed text is stored. A new kind appends `client.error.new`.
 *
 * Pure core (AGENTS.md rule 8): `clientErrorOf` (the page's raw post in, a clean report or null out), `normalizeMessage`,
 * `topFrame` and `errorSignature` take data and return data; `recordClientError` and `clientErrors` are the shell on
 * `world.db` with the clock and the live commit passed in.
 */
import type { World } from "./world.ts";

/** Where in the page it was caught: a panel's error boundary, window `error`, window `unhandledrejection`. */
const CLIENT_ERROR_SOURCES = ["panel", "error", "rejection"] as const;
type ClientErrorSource = (typeof CLIENT_ERROR_SOURCES)[number];

/** One error the page reported, cleaned: what is stored for it. */
interface ClientErrorReport { source: ClientErrorSource; message: string; frame: string; panel: string | null; route: string | null }
/** One kind as GET /api/client-errors lists it. */
interface ClientErrorKind extends ClientErrorReport {
  signature: string;
  firstCommit: string | null;
  lastCommit: string | null;
  count: number;
  firstSeen: string;
  lastSeen: string;
}
interface ClientErrorsView { from: string; to: string; kinds: ClientErrorKind[]; total: number }

const MESSAGE_MAX = 200;
const FRAME_MAX = 120;
/** At most this many new kinds a UTC day; past it a new kind is dropped (a known kind still counts), so the table stays small. */
export const MAX_NEW_KINDS_PER_DAY = 100;
/** Kinds unseen this long are dropped as new ones arrive. */
const KEEP_DAYS = 30;
const DAY_MS = 86_400_000;

const str = (v: unknown, max: number): string => (typeof v === "string" ? v : "").slice(0, max * 4);

/**
 * A message with what varies between occurrences blanked: URLs, town ids, long hex, numbers; long quoted text (which could
 * be what someone typed) becomes "…". Whitespace collapsed, at most 200 chars.
 */
export function normalizeMessage(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/(["'`])([^"'`]{41,})\1/g, "$1…$1")
    .replace(/\b(?:https?|wss?|blob|data):\S+/gi, "<url>")
    .replace(/\b[a-z]{2}_[a-z0-9]{10}\b/g, "<id>")
    .replace(/\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/gi, "<hex>")
    .replace(/\d+/g, "<n>")
    .trim()
    .slice(0, MESSAGE_MAX);
}

/** A file part with its directories, query, line:col and build hash dropped: `assets/index-Bx9_k2Qa.js:1:2345` → `index.js`. */
function fileOf(loc: string): string {
  const path = loc.replace(/[?#].*$/, "").replace(/(?::\d+)+$/, "");
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(/-[A-Za-z0-9_-]{8}(?=\.[a-z]+$)/, "");
}

/**
 * The first frame of a stack, as `function (file)`: V8's `at fn (url:1:2)` / `at url:1:2` and Firefox/Safari's `fn@url:1:2`.
 * "" when the stack has no frame.
 */
export function topFrame(stack: string): string {
  for (const line of stack.split("\n")) {
    const t = line.trim();
    const v8 = /^at (?:(.+?) \()?(.+?)\)?$/.exec(t);
    const ff = !v8 && /^([^@\s]*)@(.+)$/.exec(t);
    const m = v8 || ff;
    if (!m || !/:\d+/.test(m[2])) continue;
    const fn = (m[1] ?? "").replace(/^async /, "").trim();
    const file = fileOf(m[2]);
    return (fn ? `${fn} (${file})` : file).slice(0, FRAME_MAX);
  }
  return "";
}

/** The kind's key: the normalized message and the top frame. */
export const errorSignature = (r: { source: ClientErrorSource; message: string; frame: string }): string =>
  `${r.source}: ${r.message}${r.frame ? ` @ ${r.frame}` : ""}`;

/** A panel kind or a hash route, ids blanked, at most 60 chars: `#/doc/dc_x1/2` → `#/doc/<id>/<n>`. */
function routeOf(raw: unknown): string | null {
  const s = str(raw, 60).replace(/[?].*$/, "");
  if (!s) return null;
  return s.replace(/[A-Za-z]{2}_[A-Za-z0-9_]{6,}/g, "<id>").replace(/\d+/g, "<n>").replace(/[^A-Za-z0-9#/<>:_-]/g, "").slice(0, 60) || null;
}

/** The page's raw post, cleaned; null when it names no source or no message. */
export function clientErrorOf(raw: unknown): ClientErrorReport | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  const source = CLIENT_ERROR_SOURCES.find((s) => s === b.source);
  const message = normalizeMessage(str(b.message, MESSAGE_MAX));
  if (!source || !message) return null;
  const panel = typeof b.panel === "string" && /^[a-z][a-z-]{0,23}$/.test(b.panel) ? b.panel : null;
  return { source, message, frame: topFrame(str(b.stack, 1000)), panel, route: routeOf(b.route) };
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Count one report: a known kind adds one and takes the live commit as its last; a new kind gets a row (first and last
 * commit the live one) and a `client.error.new` event, unless today already has MAX_NEW_KINDS_PER_DAY new kinds.
 */
export function recordClientError(world: World, r: ClientErrorReport, o: { commit: string | null; now: number }): { recorded: boolean; isNew: boolean; signature: string } {
  const signature = errorSignature(r);
  const ts = new Date(o.now).toISOString();
  const known = world.db.prepare("UPDATE client_errors SET count = count + 1, lastSeen = ?, lastCommit = COALESCE(?, lastCommit) WHERE signature = ?").run(ts, o.commit, signature);
  if (known.changes > 0) return { recorded: true, isNew: false, signature };
  const today = (world.db.prepare("SELECT COUNT(*) AS n FROM client_errors WHERE firstSeen >= ?").get(utcDay(o.now)) as { n: number }).n;
  if (today >= MAX_NEW_KINDS_PER_DAY) return { recorded: false, isNew: false, signature };
  world.db.prepare("DELETE FROM client_errors WHERE lastSeen < ?").run(new Date(o.now - KEEP_DAYS * DAY_MS).toISOString());
  world.db.prepare("INSERT INTO client_errors (signature, source, message, frame, panel, route, firstCommit, lastCommit, count, firstSeen, lastSeen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)")
    .run(signature, r.source, r.message, r.frame, r.panel, r.route, o.commit, o.commit, ts, ts);
  world.events.append({ type: "client.error.new", text: `A new browser error: ${signature.slice(0, 160)}${o.commit ? ` (commit ${o.commit.slice(0, 8)})` : ""}`, payload: { signature, source: r.source, panel: r.panel, commit: o.commit } });
  return { recorded: true, isNew: true, signature };
}

/** The kinds seen in the last `hours` (default 24), most counted first; `count` is each kind's count since it was first seen. */
export function clientErrors(world: World, o: { now: number; hours?: number }): ClientErrorsView {
  const from = new Date(o.now - (o.hours ?? 24) * 3_600_000).toISOString();
  const kinds = world.db.prepare("SELECT * FROM client_errors WHERE lastSeen >= ? ORDER BY count DESC, lastSeen DESC LIMIT 200").all(from) as ClientErrorKind[];
  return { from, to: new Date(o.now).toISOString(), kinds, total: kinds.reduce((n, k) => n + k.count, 0) };
}
