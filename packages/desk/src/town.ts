/** Typed client for the agent-scoped town endpoints (bearer agent token), with retries on network errors. */
import { DeskBriefView, DeskControl, type DeskActivityInput, type DeskSessionEndInput } from "@muster-town/schema";
import { RESTART_BACKOFF_MS, restarting } from "./restart.ts";

export class TownError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface TownClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  /** delays between attempts on another 5xx; length + 1 = attempts (default 3 attempts) */
  backoffMs?: number[];
  /**
   * delays between attempts while the town looks like it is restarting (connection refused or reset, 502/503/504):
   * a redeploy no longer waits for desk sessions, so the desk rides the restart out (default RESTART_BACKOFF_MS, ~4.5 min)
   */
  restartBackoffMs?: number[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TownClient {
  private readonly base: string;
  private readonly f: typeof fetch;
  private readonly backoff: number[];
  private readonly restartBackoff: number[];

  constructor(private readonly opts: TownClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.f = opts.fetch ?? fetch;
    this.backoff = opts.backoffMs ?? [300, 1200];
    this.restartBackoff = opts.restartBackoffMs ?? RESTART_BACKOFF_MS;
  }

  get mcpUrl(): string {
    return `${this.base}/mcp`;
  }

  /**
   * One request. A restart (network error, 502/503/504) is retried on `restartBackoff`, another 5xx on `backoff`
   * (3 attempts total by default). 4xx throws TownError. Every endpoint here is safe to repeat: session-end and the
   * transcript are idempotent, activity and ack at worst repeat a line.
   */
  private async request(method: "GET" | "POST", path: string, body?: unknown, contentType = "application/json"): Promise<unknown> {
    const raw = body instanceof Uint8Array;
    let lastErr: unknown;
    let other = 0, restart = 0;
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) {
        const wasRestart = !(lastErr instanceof TownError) || restarting(lastErr.status);
        const delay = wasRestart ? this.restartBackoff[restart++] : this.backoff[other++];
        if (delay === undefined) break;
        await sleep(delay);
      }
      let res: Response;
      try {
        res = await this.f(`${this.base}${path}`, {
          method,
          headers: { Authorization: `Bearer ${this.opts.token}`, ...(body !== undefined ? { "Content-Type": contentType } : {}) },
          body: raw ? new Blob([body as Uint8Array<ArrayBuffer>]) : body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        lastErr = e;
        continue;
      }
      if (res.status >= 500) {
        lastErr = new TownError(`${method} ${path} → ${res.status}`, res.status);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new TownError(`${method} ${path} → ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`, res.status);
      }
      if (res.status === 204) return undefined;
      const text = await res.text();
      return text ? JSON.parse(text) : undefined;
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async brief(session: string): Promise<DeskBriefView> {
    return DeskBriefView.parse(await this.request("GET", `/api/agents/me/brief?session=${encodeURIComponent(session)}`));
  }

  async activity(input: DeskActivityInput): Promise<void> {
    await this.request("POST", "/api/agents/me/activity", input);
  }

  async control(session: string): Promise<DeskControl> {
    return DeskControl.parse(await this.request("GET", `/api/agents/me/control?session=${encodeURIComponent(session)}`));
  }

  async ack(ids: string[]): Promise<void> {
    await this.request("POST", "/api/agents/me/control/ack", { ids });
  }

  async sessionEnd(input: DeskSessionEndInput): Promise<unknown> {
    return this.request("POST", "/api/agents/me/session-end", input);
  }

  /** The session's SDK transcript, brotli-compressed JSONL (docs/transcripts.md). */
  async transcript(session: string, brotli: Uint8Array): Promise<unknown> {
    return this.request("POST", `/api/agents/me/transcript?session=${encodeURIComponent(session)}`, brotli, "application/x-brotli");
  }

  async health(): Promise<unknown> {
    return this.request("GET", "/api/health");
  }
}
