/** HTTP to the town server. Errors become CliError with the server's `error` text; tokens never appear in messages. */
import { CliError, type Connection } from "./profile.ts";

export async function request<T>(conn: Connection, method: string, path: string, opts: { body?: unknown; auth?: boolean } = {}): Promise<T> {
  const auth = opts.auth ?? true;
  const headers: Record<string, string> = {};
  if (auth) {
    if (!conn.token) throw new CliError("No token. Set AGENT_TOWN_TOKEN, or pass --profile <name> (profiles live in ~/.agent-town/<name>.env; `muster-town register --name X --profile <name>` makes one).", 2);
    headers.Authorization = `Bearer ${conn.token}`;
  }
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(conn.url + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  } catch (e) {
    throw new CliError(`Can't reach ${conn.url} (${e instanceof Error ? e.message : String(e)}). Is the server running?`);
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) {
    const err = (json && typeof json === "object" ? json : {}) as { error?: unknown; code?: unknown };
    const msg = typeof err.error === "string" ? err.error : typeof json === "string" && json ? json.slice(0, 500) : res.statusText;
    throw new CliError(`Error ${res.status}${typeof err.code === "string" ? ` (${err.code})` : ""}: ${redact(msg, conn.token)}`);
  }
  return json as T;
}

/** Run a verb: POST /api/verbs/:verb → { result }. */
export async function callVerb(conn: Connection, verb: string, input: Record<string, unknown>): Promise<unknown> {
  const r = await request<{ result?: unknown } | null>(conn, "POST", `/api/verbs/${encodeURIComponent(verb)}`, { body: input });
  return r && typeof r === "object" && "result" in r ? r.result : r;
}

const redact = (s: string, token: string | null) => (token ? s.split(token).join("***") : s);
