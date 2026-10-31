/**
 * AWS Signature Version 4 for S3-style requests (Tigris, S3, R2, MinIO), with node crypto only: the backup job PUTs,
 * lists and deletes a handful of objects a day, which does not justify an SDK. Header-based signing with the payload
 * hash in `x-amz-content-sha256` (S3 requires it); tested against the AWS SigV4 test suite vectors (test/backup.test.ts).
 */
import { createHash, createHmac } from "node:crypto";

export interface SigV4Credentials { accessKeyId: string; secretAccessKey: string; region: string; service?: string }

interface SigV4Request {
  method: string;
  url: URL;
  /** headers to send besides host and x-amz-date (lower-case names; all of them are signed) */
  headers?: Record<string, string>;
  /** the request body (its SHA-256 is signed; empty body when absent) */
  body?: Uint8Array;
  /** fixed time for tests (default now) */
  date?: Date;
}

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Uint8Array | string, data: string) => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding as AWS wants it: unreserved chars kept, everything else %XX upper-case (`/` kept when `keepSlash`). */
export function awsEncode(s: string, keepSlash = false): string {
  const out = encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? out.replace(/%2F/g, "/") : out;
}

function canonicalQuery(url: URL): string {
  const pairs: [string, string][] = [];
  for (const [k, v] of url.searchParams) pairs.push([awsEncode(k), awsEncode(v)]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

/** The headers to send: the caller's plus host, x-amz-date, x-amz-content-sha256 and authorization. */
export function signV4(creds: SigV4Credentials, req: SigV4Request): Record<string, string> {
  const service = creds.service ?? "s3";
  const date = req.date ?? new Date();
  const amzDate = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(req.body ?? new Uint8Array(0));
  const headers: Record<string, string> = { ...(req.headers ?? {}), host: req.url.host, "x-amz-date": amzDate };
  if (service === "s3") headers["x-amz-content-sha256"] = payloadHash;
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = names.map((h) => `${h}:${headers[h]!.trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  // the path is sent encoded once; S3 signs it as sent (no double encoding)
  const canonicalUri = req.url.pathname || "/";
  const canonicalRequest = [req.method.toUpperCase(), canonicalUri, canonicalQuery(req.url), canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${creds.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, dateStamp), creds.region), service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}
