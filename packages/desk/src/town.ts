/** Typed client for the agent-scoped town endpoints (bearer agent token), with retries on network errors. */
import { DeskBrief, DeskControl, type DeskActivityInput, type DeskSessionEndInput } from "./contract.ts";

export class TownError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface TownClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  /** delays between attempts; length + 1 = attempts (default 3 attempts) */
  backoffMs?: number[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TownClient {
  private readonly base: string;
  private readonly f: typeof fetch;
  private readonly backoff: number[];

  constructor(private readonly opts: TownClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.f = opts.fetch ?? fetch;
    this.backoff = opts.backoffMs ?? [300, 1200];
  }

  get mcpUrl(): string {
    return `${this.base}/mcp`;
  }

  /** One request; retries network errors and 5xx (3 attempts total by default). 4xx throws TownError. */
  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.backoff.length; attempt++) {
      if (attempt > 0) await sleep(this.backoff[attempt - 1]!);
      let res: Response;
      try {
        res = await this.f(`${this.base}${path}`, {
          method,
          headers: { Authorization: `Bearer ${this.opts.token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
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

  async brief(session: string): Promise<DeskBrief> {
    return DeskBrief.parse(await this.request("GET", `/api/agents/me/brief?session=${encodeURIComponent(session)}`));
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

  async health(): Promise<unknown> {
    return this.request("GET", "/api/health");
  }
}
