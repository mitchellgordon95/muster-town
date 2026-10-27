/** The S3 calls the backup job needs (put, list, delete) and the restore needs (get), path-style against `AWS_ENDPOINT_URL_S3`, signed with sigv4.ts. */
import { awsEncode, signV4, type SigV4Credentials } from "./sigv4.ts";

export interface S3Target { endpoint: string; bucket: string; creds: SigV4Credentials }

/** `fetch` is injectable for tests (default: global fetch). */
export class S3 {
  private readonly target: S3Target;
  private readonly fetchFn: typeof fetch;
  // no parameter properties: node's strip-only type stripping (scripts/backup/restore-helper.mjs imports this file directly) rejects them
  constructor(target: S3Target, fetchFn: typeof fetch = fetch) { this.target = target; this.fetchFn = fetchFn; }

  /** `host/bucket/`, for health and logs: no credentials in it */
  get dest(): string { return `${new URL(this.target.endpoint).host}/${this.target.bucket}/`; }

  private url(key: string, query?: Record<string, string>): URL {
    const base = this.target.endpoint.replace(/\/+$/, "");
    const url = new URL(`${base}/${awsEncode(this.target.bucket)}${key ? "/" + awsEncode(key, true) : ""}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    return url;
  }

  private async call(method: string, url: URL, body?: Uint8Array, headers: Record<string, string> = {}): Promise<Response> {
    const signed = signV4(this.target.creds, { method, url, headers, body });
    const res = await this.fetchFn(url, { method, headers: signed, body: body as BodyInit | undefined });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 300);
      throw new Error(`S3 ${method} ${url.pathname} failed: HTTP ${res.status}${text ? ` ${text.replace(/\s+/g, " ")}` : ""}`);
    }
    return res;
  }

  async put(key: string, body: Uint8Array, contentType = "application/octet-stream"): Promise<void> {
    await this.call("PUT", this.url(key), body, { "content-type": contentType, "content-length": String(body.byteLength) });
  }

  /** Every key under `prefix` (ListObjectsV2, following continuation tokens), sorted ascending. */
  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = { "list-type": "2", prefix };
      if (token) query["continuation-token"] = token;
      const xml = await (await this.call("GET", this.url("", query))).text();
      for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(decodeXml(m[1]!));
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? decodeXml(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "") || undefined : undefined;
    } while (token);
    return keys.sort();
  }

  /** One object (the restore side, scripts/backup/restore-helper.mjs): the response, body unread. */
  async get(key: string): Promise<Response> {
    return this.call("GET", this.url(key));
  }

  async delete(key: string): Promise<void> {
    await this.call("DELETE", this.url(key));
  }
}

const decodeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
