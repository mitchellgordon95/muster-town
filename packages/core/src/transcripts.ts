/**
 * Session transcripts (docs/transcripts.md): the Agent SDK's JSONL for one session (every prompt, tool call, tool
 * output and token count), keyed by town session id. Desks upload theirs at session end (POST /api/agents/me/transcript);
 * host sessions (meetings, 1:1s, manage, facilitation) are written by the runtime. Files are brotli next to the
 * database (<data>/transcripts/<sessionId>.jsonl.br) with one `transcripts` row each; both go after the retention
 * period (desks.transcriptDays, default 90). Readable by admins, the managers of the session's building, and the
 * session's own agent.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import type { Agent, Session } from "@muster-town/schema";
import { badRequest } from "./errors.ts";
import { nowIso } from "./util.ts";
import type { World } from "./world.ts";

/** uncompressed JSONL per session; the largest desk transcript seen so far is ~5 MB */
export const TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;
/** compressed upload limit (brotli shrinks JSONL ~4–5×) */
export const TRANSCRIPT_MAX_UPLOAD = 24 * 1024 * 1024;
export const TRANSCRIPT_DEFAULT_DAYS = 90;
const DAY = 86_400_000;

export interface TranscriptInfo {
  sessionId: string;
  agentId: string;
  bytes: number;
  storedBytes: number;
  lines: number;
  source: "desk" | "host";
  createdAt: string;
  /** when the retention sweep removes it */
  expiresAt: string;
  url: string;
}
type Row = Omit<TranscriptInfo, "expiresAt" | "url">;
const COLS = "sessionId, agentId, bytes, storedBytes, lines, source, createdAt";

export const brotli = (raw: Buffer): Buffer =>
  brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });

export class Transcripts {
  readonly dir: string;
  private lastPrune = 0;

  constructor(private readonly world: World) {
    const file = world.db.name;
    this.dir = !file || file === ":memory:" ? mkdtempSync(join(tmpdir(), "muster-transcripts-")) : join(dirname(file), "transcripts");
  }

  retentionDays(): number {
    return this.world.desksConfig().transcriptDays ?? TRANSCRIPT_DEFAULT_DAYS;
  }

  private view(r: Row): TranscriptInfo {
    return { ...r, expiresAt: new Date(Date.parse(r.createdAt) + this.retentionDays() * DAY).toISOString(), url: `/api/sessions/${r.sessionId}/transcript` };
  }

  private file(sessionId: string): string {
    if (!/^[a-z]{2}_[A-Za-z0-9]+$/.test(sessionId)) throw badRequest(`Not a session id: ${sessionId}`);
    return join(this.dir, `${sessionId}.jsonl.br`);
  }

  /**
   * Store a session's transcript, replacing any earlier one. `data` is brotli (`compressed`, from a desk) or raw JSONL.
   * Every non-empty line must be JSON.
   */
  put(session: Session, data: Buffer, opts: { compressed: boolean; source: "desk" | "host" }): TranscriptInfo {
    if (!data.length) throw badRequest("Empty transcript.");
    let raw: Buffer;
    if (opts.compressed) {
      if (data.length > TRANSCRIPT_MAX_UPLOAD) throw badRequest(`Transcript upload is ${data.length} bytes; the limit is ${TRANSCRIPT_MAX_UPLOAD}.`);
      try { raw = brotliDecompressSync(data, { maxOutputLength: TRANSCRIPT_MAX_BYTES }); } catch { throw badRequest(`Not brotli, or over ${TRANSCRIPT_MAX_BYTES} bytes uncompressed.`); }
    } else {
      if (data.length > TRANSCRIPT_MAX_BYTES) throw badRequest(`Transcript is ${data.length} bytes; the limit is ${TRANSCRIPT_MAX_BYTES}.`);
      raw = data;
    }
    const lines = raw.toString("utf8").split("\n").filter((l) => l.trim());
    if (!lines.length) throw badRequest("Empty transcript.");
    for (const [i, l] of lines.entries()) {
      try { JSON.parse(l); } catch { throw badRequest(`Line ${i + 1} of the transcript is not JSON.`); }
    }
    const stored = opts.compressed ? data : brotli(raw);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file(session.id), stored);
    const row: Row = { sessionId: session.id, agentId: session.agentId, bytes: raw.length, storedBytes: stored.length, lines: lines.length, source: opts.source, createdAt: nowIso() };
    this.world.db.prepare(`INSERT OR REPLACE INTO transcripts (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(row.sessionId, row.agentId, row.bytes, row.storedBytes, row.lines, row.source, row.createdAt);
    this.world.events.append({ type: "system", agentId: session.agentId, text: `Transcript kept for session ${session.id} (${row.lines} lines)`, payload: { transcript: true, sessionId: session.id, bytes: row.bytes, storedBytes: row.storedBytes, source: row.source } });
    this.prune();
    return this.view(row);
  }

  info(sessionId: string): TranscriptInfo | null {
    const r = this.world.db.prepare(`SELECT ${COLS} FROM transcripts WHERE sessionId = ?`).get(sessionId) as Row | undefined;
    return r && existsSync(this.file(r.sessionId)) ? this.view(r) : null;
  }

  /** The stored brotli bytes, or null. */
  read(sessionId: string): Buffer | null {
    if (!this.info(sessionId)) return null;
    return readFileSync(this.file(sessionId));
  }

  /** Drop transcripts older than the retention period (at most once an hour unless `force`). → how many went. */
  prune(now = new Date(), force = false): number {
    if (!force && now.getTime() - this.lastPrune < 3600_000) return 0;
    this.lastPrune = now.getTime();
    const cutoff = new Date(now.getTime() - this.retentionDays() * DAY).toISOString();
    const old = this.world.db.prepare("SELECT sessionId FROM transcripts WHERE createdAt < ?").all(cutoff) as { sessionId: string }[];
    for (const { sessionId } of old) rmSync(this.file(sessionId), { force: true });
    this.world.db.prepare("DELETE FROM transcripts WHERE createdAt < ?").run(cutoff);
    // files without a row (a crash between write and insert): gone once past the cutoff too
    if (existsSync(this.dir)) {
      const kept = new Set((this.world.db.prepare("SELECT sessionId FROM transcripts").all() as { sessionId: string }[]).map((r) => r.sessionId));
      for (const f of readdirSync(this.dir)) {
        const id = f.replace(/\.jsonl\.br$/, "");
        if (!kept.has(id) && f.endsWith(".jsonl.br")) {
          const s = this.world.sessions.get(id);
          if (!s || (s.endedAt ?? s.startedAt) < cutoff) rmSync(join(this.dir, f), { force: true });
        }
      }
    }
    return old.length;
  }

  /** Admins, a manager of the session's building (the agent's home, or the meeting's building), and the agent itself. */
  canRead(viewer: Agent | null, session: Session): boolean {
    if (!viewer) return false;
    if (viewer.id === session.agentId) return true;
    const p = this.world.permissions;
    if (p.isAdmin(viewer)) return true;
    const agent = this.world.agents.get(session.agentId);
    const buildings = new Set<string>();
    const home = agent ? agent.homeBuildingId ?? agent.buildingId : null;
    if (home) buildings.add(home);
    const meeting = session.meetingId ? this.world.meetings.get(session.meetingId) : null;
    if (meeting?.buildingId) buildings.add(meeting.buildingId);
    return [...buildings].some((b) => p.can(viewer, "building.manage", b));
  }
}
