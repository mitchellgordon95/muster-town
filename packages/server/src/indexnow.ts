// IndexNow (grant gr_92sfjss7w3 step 1): muster.town tells Bing, Yandex, Seznam and Naver (and through Bing, DuckDuckGo)
// about its public pages as they go up, instead of waiting to be crawled. One key, generated once and kept in the town's
// meta row, is served at /<key>.txt; every few minutes the server compares the public pages (share.ts `sitePages`) with
// what it last submitted and POSTs the new or changed URLs to api.indexnow.org. Each submit's response is a town event.
// On by default only where MUSTER_TOWN_PUBLIC_URL is muster.town (MUSTER_TOWN_INDEXNOW=on|off decides elsewhere), so a
// test server, a throwaway or a self-hosted town never submits.
// Pure core (indexNowEnabled, isIndexNowKey, indexNowDue, indexNowBody), stateful shell (IndexNow).
import type { World } from "@muster-town/core";
import { randomBytes } from "node:crypto";
import type { SitePage } from "./share.ts";

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const KEY_MARKER = "indexnowKey";
const SENT_MARKER = "indexnowSent";
/** After a refused or failed submit, wait this long before trying again (one event per try, not one per tick). */
const RETRY_MS = 6 * 3600_000;

/** Whether this server submits to IndexNow: `flag` on/off decides; unset, only where the public URL is muster.town. */
export function indexNowEnabled(flag: string | undefined, publicUrl: string | undefined): boolean {
  const f = flag?.trim().toLowerCase();
  if (f) return f === "on";
  try {
    return publicUrl ? new URL(publicUrl).hostname.toLowerCase() === "muster.town" : false;
  } catch {
    return false;
  }
}

/** A key IndexNow accepts: 8 to 128 characters of a-z, A-Z, 0-9 and dashes. */
export const isIndexNowKey = (k: string) => /^[A-Za-z0-9-]{8,128}$/.test(k);

/** The pages' URLs that are new or changed since `sent` (url → the lastmod last submitted, "" when it had none). */
export function indexNowDue(origin: string, pages: SitePage[], sent: Record<string, string>): string[] {
  return pages.map((p) => ({ url: origin + p.path, mark: p.lastmod ?? "" })).filter((p) => sent[p.url] !== p.mark).map((p) => p.url);
}

/** The POST body for one batch (IndexNow takes up to 10,000 URLs of one host per request). */
export function indexNowBody(origin: string, key: string, urls: string[]) {
  return { host: new URL(origin).host, key, keyLocation: `${origin}/${key}.txt`, urlList: urls.slice(0, 10_000) };
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number }>;

/** The submitter: its key, and `run` (one compare-and-submit) on a timer from `start`. */
export class IndexNow {
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private retryAfter = 0;
  private running = false;
  readonly key: string;
  constructor(private o: { world: World; origin: string; pages: () => SitePage[]; fetch?: Fetch; log?: (line: string) => void }) {
    const kept = o.world.town.marker(KEY_MARKER);
    if (kept && isIndexNowKey(kept)) this.key = kept;
    else { this.key = randomBytes(16).toString("hex"); o.world.town.setMarker(KEY_MARKER, this.key); }
  }

  private sent(): Record<string, string> {
    try { const v = JSON.parse(this.o.world.town.marker(SENT_MARKER) ?? "{}") as unknown; return v && typeof v === "object" ? v as Record<string, string> : {}; } catch { return {}; }
  }

  /** Submit what is new or changed; returns the response status, or null when nothing was due (or it is waiting to retry). */
  async run(now = Date.now()): Promise<number | null> {
    if (this.running || now < this.retryAfter) return null;
    const pages = this.o.pages();
    const sent = this.sent();
    const urls = indexNowDue(this.o.origin, pages, sent);
    if (!urls.length) return null;
    this.running = true;
    let status = 0, error = "";
    try {
      const res = await (this.o.fetch ?? (fetch as unknown as Fetch))(INDEXNOW_ENDPOINT, {
        method: "POST", headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(indexNowBody(this.o.origin, this.key, urls)), signal: AbortSignal.timeout(20_000),
      });
      status = res.status;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      this.running = false;
    }
    const ok = status === 200 || status === 202;
    if (ok) {
      const next: Record<string, string> = {};
      for (const p of pages) next[this.o.origin + p.path] = p.lastmod ?? "";
      this.o.world.town.setMarker(SENT_MARKER, JSON.stringify(next));
    } else this.retryAfter = now + RETRY_MS;
    const shown = urls.length > 3 ? `${urls.slice(0, 3).join(", ")} and ${urls.length - 3} more` : urls.join(", ");
    this.o.world.events.append({
      type: "system", agentId: null,
      text: ok ? `IndexNow: submitted ${urls.length} URL${urls.length === 1 ? "" : "s"} (${shown}), response ${status}; key file ${this.o.origin}/${this.key}.txt` : `IndexNow: submit of ${urls.length} URL${urls.length === 1 ? "" : "s"} failed (${error || `response ${status}`}); retrying in 6 hours`,
      payload: { indexNow: { status, urls, keyLocation: `${this.o.origin}/${this.key}.txt`, ...(error && { error }) } },
    });
    this.o.log?.(`[indexnow] ${urls.length} url(s) → ${status || error}`);
    return status;
  }

  /** First run after `firstMs` (let the server settle), then every `everyMs`. */
  start(everyMs = 10 * 60_000, firstMs = 60_000): void {
    const tick = () => { this.run().catch((e) => this.o.log?.(`[indexnow] ${e instanceof Error ? e.message : String(e)}`)); };
    this.first = setTimeout(tick, firstMs); this.first.unref?.();
    this.timer = setInterval(tick, everyMs); this.timer.unref?.();
  }
  stop(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = this.timer = null;
  }
}
