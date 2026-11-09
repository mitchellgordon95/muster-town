/**
 * Host checks for the self-hosted towns directory (design dc_d6chojzl2a): host validation (§1) and the TXT proof (§2). The
 * SSRF-guarded fetch lives in core (net-guard.ts), shared with the asks' claim checks.
 */
import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
export { blockedAddress, safeGet, type Fetcher } from "@muster-town/core";

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

// ---- step 2: the TXT proof (design dc_d6chojzl2a §2) ----

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
