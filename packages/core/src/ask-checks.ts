/**
 * Load-bearing claims, pre-checked (docs/legible-delegation.md §5, build step 4). Each money ask names the one or two
 * claims that would change the decision if they were wrong, with how to check each. Where the check is mechanical the
 * server runs it and stores the result on the claim, so the card shows "PR #392: green, mergeable, checked 4 min ago":
 *
 * - `pr`: a GitHub pull request (a number on the collective's repo, or its URL) is merged, or open, mergeable and green.
 * - `url`: an https URL on the public internet answers 200-399 within 5 s (core net-guard.ts: no private or Fly-internal hosts).
 * - `api`: `GET <path> <json-pointer> [expected]` against the town's own API, in-process (`world.host.apiGet`), no network.
 * - `kr`: a key result whose howToCheck is a curl or a URL is run as a `url` check; any other is manual.
 * - `manual`: no result; a human checks it.
 *
 * Checks run after an ask is filed (`queueClaimChecks`, never blocking the create) and again when a card is opened with
 * results older than `CLAIM_STALE_MS` (`GET /api/asks/:id`). Each run appends `ask.checked`.
 */
import type { Ask, AskClaim } from "@muster-town/schema";
import { safeGet, type Fetcher } from "./net-guard.ts";
import { verifiedNotice } from "./notices.ts";
import { REPO_TOKEN_SECRET } from "./secrets.ts";
import type { World } from "./world.ts";

/** A check result older than this is run again before the card is shown (the invariant: never older when shown). */
export const CLAIM_STALE_MS = 5 * 60_000;
const URL_TIMEOUT_MS = 5_000;
/** Whether the server can run this claim's check: pr, url and api always; kr when its howToCheck is a curl or a URL. */
function mechanical(world: World, c: AskClaim): boolean {
  if (c.check.kind === "kr") { const kr = world.keyResults.get(c.check.ref?.trim() ?? ""); return !kr || !!urlOfHowToCheck(kr.howToCheck); }
  return c.check.kind === "pr" || c.check.kind === "url" || c.check.kind === "api";
}

type Result = NonNullable<AskClaim["result"]>;

/** What a check reaches the outside with; tests pass fakes. */
interface CheckDeps {
  /** GitHub's REST API (default: global fetch) */
  fetch?: typeof fetch;
  /** a public https URL's status (default: core net-guard `safeGet`, status only) */
  getUrl?: Fetcher;
  now?: () => Date;
}

/** Whether an ask has a mechanical claim whose result is missing or older than `CLAIM_STALE_MS`. */
export function claimsStale(world: World, ask: Pick<Ask, "claims">, now = Date.now()): boolean {
  return ask.claims.some((c) => mechanical(world, c) && (!c.result || now - Date.parse(c.result.at) > CLAIM_STALE_MS));
}

/**
 * Run every mechanical claim of the ask and store the results on it (one `ask.checked` event). A check that cannot run
 * (no repo, no token, a refused host, a timeout) is a failed result with the reason, never a thrown error. Returns the
 * ask as stored, or the ask unchanged when it has nothing to check.
 */
export async function runClaimChecks(world: World, ask: Ask, deps: CheckDeps = {}): Promise<Ask> {
  if (!ask.claims.some((c) => mechanical(world, c))) return ask;
  const now = deps.now ?? (() => new Date());
  const results = await Promise.all(ask.claims.map((c) => checkClaim(world, c, deps).then((r) => r && { ...r, at: now().toISOString() })));
  // the ask may have changed while the checks ran: write the results onto its claims as they stand now, matched by text
  const cur = world.asks.get(ask.id);
  if (!cur) return ask;
  const byText = new Map(ask.claims.map((c, i) => [`${c.text}\n${c.check.kind}\n${c.check.ref ?? ""}`, results[i]]));
  const claims = cur.claims.map((c) => { const r = byText.get(`${c.text}\n${c.check.kind}\n${c.check.ref ?? ""}`); return r ? { ...c, result: r } : c; });
  const next = world.asks.upsert({ ...cur, claims });
  // step 10: a passed kr check verifies its key result (once: a verified one is left alone)
  for (const c of claims) if (c.check.kind === "kr" && c.result?.ok) verifyKeyResult(world, c.check.ref?.trim() ?? "", c.result.note ?? "");
  const ran = results.filter((r): r is Result & { at: string } => !!r);
  world.events.append({
    type: "ask.checked", buildingId: cur.buildingId,
    text: `Checked ${ran.length} claim${ran.length === 1 ? "" : "s"} of "${cur.title.slice(0, 80)}": ${ran.filter((r) => r.ok).length} passed`,
    payload: { askId: cur.id, results: ran.map((r) => ({ ok: r.ok, note: r.note ?? "" })) },
  });
  return next;
}

/** Run the ask's checks in the background after a create (never blocks it; a failure is only logged). Only where the server turned them on (`world.host.claimChecks`). */
export function queueClaimChecks(world: World, askId: string): void {
  const ask = world.asks.get(askId);
  if (!world.host.claimChecks || !ask || !ask.claims.some((c) => mechanical(world, c))) return;
  setImmediate(() => { runClaimChecks(world, ask).catch((e: unknown) => console.warn(`[asks] claim checks of ${askId} failed: ${e instanceof Error ? e.message : String(e)}`)); });
}

async function checkClaim(world: World, c: AskClaim, deps: CheckDeps): Promise<Omit<Result, "at"> | null> {
  const ref = c.check.ref?.trim() ?? "";
  try {
    switch (c.check.kind) {
      case "pr": return await checkPr(world, ref, deps);
      case "url": return await checkUrl(ref, deps);
      case "api": return await checkApi(world, ref);
      case "kr": {
        const kr = world.keyResults.get(ref);
        if (!kr) return { ok: false, note: `no key result ${ref}` };
        const url = urlOfHowToCheck(kr.howToCheck);
        return url ? await checkUrl(url, deps) : null;
      }
      default: return null;
    }
  } catch (e) {
    return { ok: false, note: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  }
}

/** A key result whose check the server ran and passed: evidence "verified" (status unchanged), `kr.verified` and a `verified` notice. */
function verifyKeyResult(world: World, id: string, note: string): void {
  const kr = world.keyResults.get(id);
  if (!kr || kr.evidence === "verified") return;
  const next = world.keyResults.upsert({ ...kr, evidence: "verified", updatedAt: new Date().toISOString() });
  world.events.append({ type: "kr.verified", buildingId: kr.buildingId, text: `Key result verified by a check the server ran: ${kr.text}`, payload: { keyResultId: kr.id, grantId: kr.grantId, from: kr.evidence, note } });
  verifiedNotice(world, next, "A check the server ran");
}

/** The URL a key result's howToCheck runs, when it is a curl command or a bare URL; else null (a manual check). */
export function urlOfHowToCheck(howToCheck: string): string | null {
  const t = howToCheck.trim();
  if (/^https?:\/\/\S+$/.test(t)) return t;
  if (!/^curl\b/.test(t)) return null;
  return /\bhttps?:\/\/[^\s'"|>]+/.exec(t)?.[0] ?? null;
}

// ---- url ----

/** Hosts that are never fetched whatever they resolve to: Fly's private network and local names. */
const PRIVATE_NAMES = /(?:^|\.)(?:localhost|internal|local|flycast|lan|home\.arpa)$/i;

async function checkUrl(ref: string, deps: CheckDeps): Promise<Omit<Result, "at">> {
  let u: URL;
  try { u = new URL(ref); } catch { return { ok: false, note: `not a URL: ${ref.slice(0, 100)}` }; }
  if (PRIVATE_NAMES.test(u.hostname)) return { ok: false, note: `refused: ${u.hostname} is a private host` };
  const r = await (deps.getUrl ?? safeGet)(u.toString(), { timeoutMs: URL_TIMEOUT_MS, maxBytes: 64 * 1024, statusOnly: true });
  return { ok: r.status >= 200 && r.status < 400, note: `HTTP ${r.status}` };
}

// ---- pr ----

/** `owner/repo` and number of a PR ref: "392", "#392", or "https://github.com/o/r/pull/392" (the collective's repo by default). */
function prRef(world: World, ref: string): { owner: string; repo: string; n: number } | null {
  const url = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(ref);
  if (url) return { owner: url[1]!, repo: url[2]!, n: Number(url[3]) };
  const n = /^#?(\d+)$/.exec(ref)?.[1];
  const repo = /github\.com[/:]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/*$/.exec(world.town.get().workspace?.repoUrl ?? "");
  return n && repo ? { owner: repo[1]!, repo: repo[2]!, n: Number(n) } : null;
}

/** The collective's repo token (the GH_TOKEN secret, else the host's env), or null (anonymous: public repos only). */
function repoToken(world: World): string | null {
  try { return world.secrets.value(REPO_TOKEN_SECRET) ?? process.env.GH_TOKEN ?? null; } catch { return process.env.GH_TOKEN ?? null; }
}

const CHECK_OK = new Set(["success", "neutral", "skipped"]);

async function checkPr(world: World, ref: string, deps: CheckDeps): Promise<Omit<Result, "at">> {
  const pr = prRef(world, ref);
  if (!pr) return { ok: false, note: `not a PR on a GitHub repo: ${ref.slice(0, 100)}` };
  const token = repoToken(world);
  const gh = async <T>(path: string): Promise<T> => {
    const res = await (deps.fetch ?? fetch)(`https://api.github.com/repos/${pr.owner}/${pr.repo}${path}`, {
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(URL_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GitHub ${path}: HTTP ${res.status}`);
    return await res.json() as T;
  };
  const p = await gh<{ state: string; merged?: boolean; mergeable?: boolean | null; head: { sha: string } }>(`/pulls/${pr.n}`);
  if (p.merged) return { ok: true, note: `PR #${pr.n} is merged` };
  if (p.state !== "open") return { ok: false, note: `PR #${pr.n} is closed without merging` };
  const runs = (await gh<{ check_runs: { name: string; status: string; conclusion: string | null }[] }>(`/commits/${p.head.sha}/check-runs?per_page=100`)).check_runs;
  const failed = runs.filter((r) => r.status === "completed" && !CHECK_OK.has(r.conclusion ?? "")).map((r) => r.name);
  const pending = runs.filter((r) => r.status !== "completed").length;
  const ci = failed.length ? `red: ${failed.slice(0, 3).join(", ")} failed` : pending ? `${pending} check${pending === 1 ? "" : "s"} still running` : runs.length ? "green" : "no checks ran";
  const merge = p.mergeable === false ? "not mergeable" : p.mergeable === true ? "mergeable" : "mergeability not known yet";
  return { ok: !failed.length && !pending && runs.length > 0 && p.mergeable === true, note: `PR #${pr.n}: ${ci}, ${merge}` };
}

// ---- api ----

/** RFC 6901: the value at `pointer` in `doc`, or undefined. */
function atPointer(doc: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "/") return doc;
  return pointer.replace(/^\//, "").split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<unknown>((v, k) => (v !== null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), doc);
}

async function checkApi(world: World, ref: string): Promise<Omit<Result, "at">> {
  const m = /^(?:GET\s+)?(\/\S*)\s+(\/\S*)(?:\s+(.+))?$/.exec(ref);
  if (!m) return { ok: false, note: "ref is not \"GET <path> <json-pointer> [expected]\"" };
  const [, path, pointer, expected] = m as unknown as [string, string, string, string | undefined];
  if (!path.startsWith("/api/")) return { ok: false, note: "an api check reads the town's own /api/ paths only" };
  if (!world.host.apiGet) return { ok: false, note: "no in-process API in this town" };
  const r = await world.host.apiGet(path);
  if (r.status < 200 || r.status >= 300) return { ok: false, note: `GET ${path}: HTTP ${r.status}` };
  const v = atPointer(r.body, pointer);
  const shown = v === undefined ? "missing" : JSON.stringify(v).slice(0, 120);
  if (expected !== undefined) return { ok: v !== undefined && String(typeof v === "object" ? JSON.stringify(v) : v) === expected.trim(), note: `${pointer} is ${shown}, expected ${expected.trim()}` };
  return { ok: v !== undefined && v !== null, note: `${pointer} is ${shown}` };
}
