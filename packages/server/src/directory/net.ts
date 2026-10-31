/**
 * Host checks for the self-hosted towns directory (design dc_d6chojzl2a): host validation (§1), the SSRF-guarded fetch and the TXT proof (§2).
 */
import { lookup as dnsLookup, Resolver } from "node:dns/promises";
import { get as httpsGet } from "node:https";
import { BlockList, isIP } from "node:net";
import { domainToASCII } from "node:url";

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** names that never resolve on the public internet, or are ours already (the Workshop and hosted collectives are tiles) */
const RESERVED = ["localhost", "local", "internal", "lan", "home.arpa", "onion", "invalid", "test", "example", "muster.town"];

/** A registrable hostname (ASCII, lowercase, no trailing dot), or a reason it isn't one. */
export function normalizeHost(input: string): { host: string } | { error: string } {
  let h = input.trim().toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (!h) return { error: "host is empty." };
  if (/[:/@\s]/.test(h) || isIP(h) !== 0) return { error: "host must be a bare DNS name: no scheme, port, path or IP address." };
  h = domainToASCII(h);
  if (!h) return { error: "host is not a valid domain name." };
  if (h.length > 253) return { error: "host is longer than 253 characters." };
  if (RESERVED.some((r) => h === r || h.endsWith("." + r))) return { error: `${h} can't be listed (a local, reserved or muster.town name).` };
  const labels = h.split(".");
  if (labels.length < 2) return { error: "host needs at least two labels (e.g. town.example.org)." };
  if (!labels.every((l) => LABEL.test(l))) return { error: "host has an invalid label (letters, digits and inner dashes, 1 to 63 each)." };
  if (/^\d+$/.test(labels[labels.length - 1]!)) return { error: "host's top-level domain can't be all digits." };
  return { host: h };
}

// ---- step 2: the SSRF-guarded fetch and the TXT proof (design dc_d6chojzl2a §2) ----

/** Addresses the directory never connects to: loopback, private, link-local, CGNAT, ULA (Fly's 6PN fdaa::), multicast, reserved. */
const BLOCKED = (() => {
  const b = new BlockList();
  for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
    ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) b.addSubnet(net, bits, "ipv4");
  for (const [net, bits] of [["::", 128], ["::1", 128], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const)
    b.addSubnet(net, bits, "ipv6");
  return b;
})();

/** Whether an IP address is one the directory must not fetch (IPv4-mapped IPv6, dotted or hex, is judged as its IPv4). */
export function blockedAddress(address: string): boolean {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  const a = dotted ? dotted[1]! : hex ? [parseInt(hex[1]!, 16) >> 8, parseInt(hex[1]!, 16) & 255, parseInt(hex[2]!, 16) >> 8, parseInt(hex[2]!, 16) & 255].join(".") : address;
  const v = isIP(a);
  if (v === 0) return true;
  return BLOCKED.check(a, v === 4 ? "ipv4" : "ipv6");
}

type LookupAll = (host: string) => Promise<{ address: string; family: number }[]>;
const realLookupAll: LookupAll = (host) => dnsLookup(host, { all: true, verbatim: true });

export interface SafeGetOptions {
  timeoutMs: number;
  maxBytes: number;
  /** tests only: a fake DNS, an extra CA for a local TLS server, and the address rule (default blockedAddress) */
  lookupAll?: LookupAll;
  ca?: string;
  isBlocked?: (address: string) => boolean;
}
export interface SafeResponse { status: number; body: string }
export type Fetcher = (url: string, opts: SafeGetOptions) => Promise<SafeResponse>;

const USER_AGENT = "muster.town-directory/1 (+https://muster.town)";

/**
 * GET an https URL on the public internet only: every address the host resolves to is checked inside the socket's `lookup`, so DNS
 * rebinding between check and connect can't happen. No redirects (a 3xx rejects with "redirected to …"), body capped at maxBytes,
 * TLS verified, no cookies or auth headers.
 */
export const safeGet: Fetcher = (url, opts) => new Promise<SafeResponse>((resolveP, rejectP) => {
  let u: URL;
  try { u = new URL(url); } catch { return rejectP(new Error("bad url")); }
  if (u.protocol !== "https:") return rejectP(new Error("https only"));
  const hostname = u.hostname.replace(/^\[|\]$/g, "");
  // an IP literal never reaches `lookup`: judge it here
  const isBlocked = opts.isBlocked ?? blockedAddress;
  if (isIP(hostname) !== 0 && isBlocked(hostname)) return rejectP(new Error(`refused: ${hostname} is a private or reserved address`));
  const lookupAll = opts.lookupAll ?? realLookupAll;
  const lookup = (host: string, o: { all?: boolean }, cb: (err: Error | null, address: string | { address: string; family: number }[], family?: number) => void) => {
    lookupAll(host).then((addrs) => {
      if (!addrs.length) return cb(Object.assign(new Error(`${host} has no address`), { code: "ENOTFOUND" }), "");
      const bad = addrs.find((a) => isBlocked(a.address));
      if (bad) return cb(new Error(`refused: ${host} resolves to ${bad.address}, a private or reserved address`), "");
      if (o?.all) cb(null, addrs);
      else cb(null, addrs[0]!.address, addrs[0]!.family);
    }, (e: Error) => cb(e, ""));
  };
  let done = false;
  const finish = (err: Error | null, res?: SafeResponse) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (err) { req.destroy(); rejectP(err); } else resolveP(res!);
  };
  const req = httpsGet(u, { lookup: lookup as never, headers: { "user-agent": USER_AGENT, accept: "*/*" }, agent: false, ...(opts.ca ? { ca: opts.ca } : {}) }, (res) => {
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400) { res.resume(); return finish(new Error(`redirected to ${String(res.headers.location ?? "?").slice(0, 200)}`)); }
    const chunks: Buffer[] = [];
    let n = 0;
    res.on("data", (c: Buffer) => {
      n += c.length;
      if (n > opts.maxBytes) return finish(new Error(`response over ${opts.maxBytes} bytes`));
      chunks.push(c);
    });
    res.on("end", () => finish(null, { status, body: Buffer.concat(chunks).toString("utf8") }));
    res.on("error", (e) => finish(e));
  });
  const timer = setTimeout(() => finish(new Error(`timed out after ${opts.timeoutMs} ms`)), opts.timeoutMs);
  req.on("error", (e) => finish(e));
});

type TxtResult = { result: "pass" } | { result: "none"; error: string } | { result: "error"; error: string };
export type TxtResolver = (name: string) => Promise<string[][]>;

/** The default resolver: 3 s per try, 2 tries (design §2). */
export function defaultTxtResolver(): TxtResolver {
  const r = new Resolver({ timeout: 3000, tries: 2 });
  return (name) => r.resolveTxt(name);
}

/**
 * The TXT proof at `_muster-town.<host>`: pass if any record (chunks joined) is `muster-town-verify=<token>` or the bare token.
 * ENOTFOUND/ENODATA = no proof; anything else (ETIMEOUT, ESERVFAIL, …) = couldn't check, which never counts as a miss.
 */
export async function resolveTxtProof(host: string, token: string, resolve: TxtResolver): Promise<TxtResult> {
  const name = `_muster-town.${host}`;
  let records: string[][];
  try {
    records = await resolve(name);
  } catch (e) {
    const code = (e as { code?: string }).code ?? "";
    if (code === "ENOTFOUND" || code === "ENODATA") return { result: "none", error: `no TXT record at ${name}` };
    return { result: "error", error: `TXT lookup of ${name} failed (${code || (e instanceof Error ? e.message : String(e))})` };
  }
  const want = `muster-town-verify=${token}`;
  if (records.some((chunks) => { const v = chunks.join("").trim(); return v === want || v === token; })) return { result: "pass" };
  return { result: "none", error: `TXT at ${name} doesn't carry ${want}` };
}
