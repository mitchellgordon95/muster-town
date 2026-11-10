/**
 * The SSRF guard: GET an https URL on the public internet only. Moved from the server's towns directory (design
 * dc_d6chojzl2a §2) so the asks' claim checks (ask-checks.ts) share it; the directory re-exports it.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { get as httpsGet } from "node:https";
import { BlockList, isIP } from "node:net";

/** Addresses the town never fetches from: loopback, private, link-local, CGNAT, ULA (Fly's 6PN fdaa::), multicast, reserved. */
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
  /** resolve with the status as soon as the headers arrive (body ""), a 3xx included: the claim checks need only the status */
  statusOnly?: boolean;
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
    if (opts.statusOnly) { finish(null, { status, body: "" }); res.destroy(); return; }
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
