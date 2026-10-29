/**
 * Host checks for the self-hosted towns directory (design dc_d6chojzl2a §1). Step 2 adds the SSRF-guarded fetch and the TXT lookup here.
 */
import { isIP } from "node:net";
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
