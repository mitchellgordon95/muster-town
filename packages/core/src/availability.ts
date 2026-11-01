/**
 * Promised and available (docs/bank.md, Mitchell 2026-11-01). A Bank input's tokens are a promise: the donor's ceiling,
 * never proof the provider will serve them. What it actually serves is observed, per input and model class, from what
 * the provider says: a session's error at its end, and the SDK's `rate_limit_event`s while it runs. The Bank never
 * predicts a limit (the learned daily cap this replaces froze the town on one Fable-only limit).
 *
 * - `classifyFailure` reads an error as a model limit (one model class: "Switch to another model to continue"), a window
 *   (every model on the input: a five-hour or weekly plan limit), billing (an API key out of credit) or auth (a revoked
 *   or invalid key). Anything else (overloaded, a transient 429, a crash) is not about the credential: null.
 * - A limit is in force until the reset the provider named (`until`) or, with none, until `probeAt`: then one session
 *   may try. Failing again doubles the wait (1 h → 24 h for limits, 6 h → 48 h for billing and auth); a session that
 *   succeeds on the input and model clears it. An admin may clear one by hand ("try now").
 * Dispatch (`Budget.fundingFor`) skips an input that is limited for the session's model; the work waits with the
 * limit's reason when nothing else can run it. It never switches the model.
 */
import { modelClass, type CredentialFailureKind, type CredentialLimit, type ModelClass } from "@muster-town/schema";
import { parseResetsAt } from "./drift.ts";
import type { EventLog } from "./events.ts";
import type { Repos } from "./store.ts";
import { stamp } from "./time.ts";
import { newId } from "./util.ts";

const HOUR = 3_600_000;
type LimitScope = ModelClass | "*";

export interface CredentialFailure {
  kind: CredentialFailureKind;
  /** the model class it limits, or every model on the input */
  scope: LimitScope;
  /** the reset the message names, when it names one */
  resetsAt: string | null;
}

/** Errors that are about the request or the service, not the credential: never a limit. */
const TRANSIENT = /overloaded|\b529\b|rate_limit_error|too many requests|\bECONN|socket hang up|timed? ?out|internal server error|api_error\b/i;
const AUTH = /invalid x-api-key|authentication_error|invalid api key|invalid authentication|invalid bearer|oauth token (?:has )?(?:expired|been revoked)|token (?:has been|was) revoked|\b401\b|permission_error/i;
const BILLING = /credit balance is too low|billing_error|insufficient (?:credit|funds|balance)|payment required|\b402\b|purchase credits/i;
const MODEL_LIMIT = /switch to another model|seven_day_(?:opus|sonnet)|(?:opus|sonnet|fable) (?:weekly )?limit/i;
const WINDOW = /hit your (?:\w+ )*limit|usage limit|limit reached|spend limit|session limit resets|monthly spend|five_hour|seven_day/i;

/** "Claude AI usage limit reached|1761962400" → that epoch second as ISO; else the "resets 3pm (UTC)" form. */
function resetOf(text: string, at: Date): string | null {
  const epoch = /\|(\d{10})\b/.exec(text);
  if (epoch) {
    const t = Number(epoch[1]) * 1000;
    if (t > at.getTime()) return new Date(t).toISOString();
  }
  return parseResetsAt(text, at);
}

/** What a session's error means for the credential it ran on, or null when it isn't about the credential. */
export function classifyFailure(text: string | null | undefined, model: string | null | undefined, at = new Date()): CredentialFailure | null {
  if (!text) return null;
  if (AUTH.test(text)) return { kind: "auth", scope: "*", resetsAt: null };
  if (BILLING.test(text)) return { kind: "billing", scope: "*", resetsAt: null };
  if (MODEL_LIMIT.test(text)) {
    const named = /seven_day_opus|opus (?:weekly )?limit/i.test(text) ? "opus" : /seven_day_sonnet|sonnet (?:weekly )?limit/i.test(text) ? "sonnet" : /fable (?:weekly )?limit/i.test(text) ? "fable" : modelClass(model);
    return { kind: "model-limit", scope: named, resetsAt: resetOf(text, at) };
  }
  if (TRANSIENT.test(text) && !WINDOW.test(text.replace(/rate_limit_error/gi, ""))) return null;
  if (WINDOW.test(text)) return { kind: "window", scope: "*", resetsAt: resetOf(text, at) };
  return null;
}

/** The wait before the next try when the provider named no reset: doubles per failure, capped. */
export function backoffMs(kind: CredentialFailureKind, failures: number): number {
  const [base, cap] = kind === "billing" || kind === "auth" ? [6 * HOUR, 48 * HOUR] : [HOUR, 24 * HOUR];
  return Math.min(cap, base * 2 ** Math.max(0, failures - 1));
}

const SCOPE_WORD: Record<LimitScope, string> = { "*": "every model", fable: "Fable", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", other: "this model" };
const KIND_WORD: Record<CredentialFailureKind, string> = { "model-limit": "limited", window: "limited", billing: "out of credit", auth: "refused (key invalid or revoked)" };

/** When the limit lifts or is tried again, or null when it is not in force at `now`. */
export function limitEnds(l: CredentialLimit): string | null {
  return l.until ?? l.probeAt;
}

/** A limit is in force until its reset, or until its next probe when no reset is known. */
export function inForce(l: CredentialLimit, now: Date): boolean {
  if (l.clearedAt) return false;
  const end = limitEnds(l);
  return !!end && end > now.toISOString();
}

/** The hold's words, as shown on held work and the Bank: "Max plan: Fable limited, resets 2026-11-06 18:00 UTC". */
export function limitText(l: CredentialLimit, label: string): string {
  const what = l.scope === "*" ? KIND_WORD[l.kind] : `${SCOPE_WORD[l.scope]} ${KIND_WORD[l.kind]}`;
  const when = l.until ? `resets ${stamp(l.until)}` : l.probeAt ? `tries again ${stamp(l.probeAt)}` : "";
  return `${label}: ${what}${when ? `, ${when}` : ""}`;
}

/** The Bank's view of observed credential limits (`world.bank.availability`). */
export class Availability {
  constructor(private repos: Repos, private events: EventLog) {}

  /** Open (uncleared) limits, newest first; one input's when `inputId` is given. */
  open(inputId?: string): CredentialLimit[] {
    return inputId
      ? this.repos.credentialLimits.where("inputId = ? AND clearedAt IS NULL", [inputId], "ORDER BY lastAt DESC")
      : this.repos.credentialLimits.where("clearedAt IS NULL", [], "ORDER BY lastAt DESC");
  }

  /** The limit keeping `inputId` from serving `model` now (every-model limits first), or null. No model: every-model limits only. */
  limitFor(inputId: string, model: string | null | undefined, now = new Date()): CredentialLimit | null {
    const cls = model ? modelClass(model) : null;
    const rows = this.open(inputId).filter((l) => inForce(l, now) && (l.scope === "*" || l.scope === cls));
    return rows.find((l) => l.scope === "*") ?? rows[0] ?? null;
  }

  available(inputId: string, model: string | null | undefined, now = new Date()): boolean {
    return !this.limitFor(inputId, model, now);
  }

  /** The input can serve no model at all (an every-model limit in force): its credit can't be spent before that ends. */
  blockedUntil(inputId: string, now = new Date()): string | null {
    const l = this.limitFor(inputId, null, now);
    return l ? limitEnds(l) : null;
  }

  /**
   * A session on `inputId` ended with `text`: record the limit it reveals (or refresh the open one for the same scope:
   * one more failure, the new reset or a longer backoff). Returns the limit, or null when the error isn't about the credential.
   */
  recordFailure(o: { inputId: string; model: string | null | undefined; text: string; sessionId?: string | null; label?: string }, now = new Date()): CredentialLimit | null {
    const f = classifyFailure(o.text, o.model, now);
    if (!f) return null;
    return this.limit({ inputId: o.inputId, scope: f.scope, kind: f.kind, until: f.resetsAt, reason: o.text, sessionId: o.sessionId ?? null, label: o.label }, now);
  }

  /** Record (or refresh) a limit on one input and scope. */
  limit(o: { inputId: string; scope: LimitScope; kind: CredentialFailureKind; until: string | null; reason: string; sessionId?: string | null; label?: string }, now = new Date()): CredentialLimit {
    const at = now.toISOString();
    const prev = this.repos.credentialLimits.first("inputId = ? AND scope = ? AND clearedAt IS NULL", [o.inputId, o.scope]);
    const failures = prev ? prev.failures + 1 : 1;
    const until = o.until && o.until > at ? o.until : null;
    const row = this.repos.credentialLimits.upsert({
      id: prev?.id ?? newId("cl"), inputId: o.inputId, scope: o.scope, kind: o.kind, reason: o.reason.replace(/\s+/g, " ").trim().slice(0, 500),
      until, probeAt: until ? null : new Date(now.getTime() + backoffMs(o.kind, failures)).toISOString(),
      failures, sessionId: o.sessionId ?? prev?.sessionId ?? null, since: prev?.since ?? at, lastAt: at, clearedAt: null,
    });
    const label = o.label ?? this.repos.bankInputs.get(o.inputId)?.label ?? o.inputId;
    this.events.append({ type: "bank.limit", text: limitText(row, label), payload: { limitId: row.id, inputId: row.inputId, scope: row.scope, kind: row.kind, until: row.until, probeAt: row.probeAt, failures: row.failures, sessionId: row.sessionId, reason: row.reason } });
    return row;
  }

  /** A session on `inputId` and `model` succeeded: the input serves that model, so its limits for it (and every-model ones) clear. */
  recordSuccess(inputId: string, model: string | null | undefined, now = new Date(), why = "a session succeeded"): number {
    const cls = modelClass(model);
    const rows = this.open(inputId).filter((l) => l.scope === "*" || l.scope === cls);
    for (const l of rows) this.clear(l, now, why);
    return rows.length;
  }

  /** Clear one limit (a success, an `allowed` rate-limit event, or an admin's "try now"). */
  clear(l: CredentialLimit, now = new Date(), why = "cleared"): CredentialLimit {
    const row = this.repos.credentialLimits.upsert({ ...l, clearedAt: now.toISOString() });
    const label = this.repos.bankInputs.get(l.inputId)?.label ?? l.inputId;
    this.events.append({ type: "bank.limit", text: `${label}: ${l.scope === "*" ? "available again" : `${SCOPE_WORD[l.scope]} available again`} (${why})`, payload: { limitId: l.id, inputId: l.inputId, scope: l.scope, cleared: true, why } });
    return row;
  }

  /**
   * The SDK's `rate_limit_event` for a session on `inputId`: `rejected` records the window it names with its reset;
   * `allowed` clears an open limit on that window's scope. `allowed_warning` changes nothing (the Bank doesn't predict).
   */
  observeRateLimit(inputId: string, info: { status?: string; resetsAt?: number; rateLimitType?: string }, sessionId?: string | null, now = new Date()): CredentialLimit | null {
    const scope: LimitScope = info.rateLimitType === "seven_day_opus" ? "opus" : info.rateLimitType === "seven_day_sonnet" ? "sonnet" : "*";
    if (info.status === "rejected") {
      const until = typeof info.resetsAt === "number" ? new Date(info.resetsAt * 1000).toISOString() : null;
      return this.limit({ inputId, scope, kind: scope === "*" ? "window" : "model-limit", until, reason: `rate_limit_event ${info.rateLimitType ?? "window"} rejected`, sessionId }, now);
    }
    if (info.status === "allowed") {
      const open = this.repos.credentialLimits.first("inputId = ? AND scope = ? AND clearedAt IS NULL AND kind IN ('window', 'model-limit')", [inputId, scope]);
      if (open) this.clear(open, now, `${info.rateLimitType ?? "the plan"} reports allowed`);
    }
    return null;
  }
}
