/**
 * "Met, unverified" (1:1 mt_msnjkpgwdb decision 9): a grant closed as done marks each open key result met when its
 * evidence names a live check, and "met, unverified" when it stands on code and tests alone. The town shows it as such
 * and nobody is asked about it; a human can still flip it to met or missed from the grant page.
 *
 * This file is the pure core (decision 15): text in, a boolean out. No World, no database, no clock.
 */
import type { KeyResultStatus } from "@muster-town/schema";

/** Hosts where code lives, not the town: a link there shows what was written, not what was seen running. */
const CODE_HOSTS = /^(?:[a-z0-9-]+\.)*(?:github\.com|githubusercontent\.com|gitlab\.com|bitbucket\.org|npmjs\.com)$/i;
const URL = /\bhttps?:\/\/([a-z0-9.-]+)(?::\d+)?(\/[^\s)>\]"'`]*)?/gi;
/** A local address is a developer's machine, not the live town. */
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)$/i;
/** Someone says they looked at the running town. */
const SEEN_LIVE = /\b(?:checked|seen|verified|confirmed|observed|watched|tested|measured|read)\b[^.\n]{0,40}\blive\b|\blive (?:check|town|site|server|commit)\b[^.\n]{0,60}\b(?:shows?|returns?|says?|reads?|has|lists?)\b|\bon the live (?:town|site|server)\b|\bin prod(?:uction)?\b/i;
/** A record only the running town writes: a notice, or an event by number. */
const LIVE_RECORD = /\bnt_[a-z0-9]{6,}\b|\bevents? (?:#|id )?\d{3,}\b/i;

/**
 * Whether evidence names a live check: a URL that is not a code host or a local address, a notice id or an event
 * number, or the words that someone saw it on the live town. A PR, a commit, a test name or a doc id alone do not.
 */
export function namesLiveCheck(evidence: string): boolean {
  if (!evidence.trim()) return false;
  for (const m of evidence.matchAll(URL)) {
    const host = m[1]!.replace(/\.$/, "");
    if (!CODE_HOSTS.test(host) && !LOCAL_HOST.test(host)) return true;
  }
  return LIVE_RECORD.test(evidence) || SEEN_LIVE.test(evidence);
}

/**
 * The status a key result takes when its grant closes as done: met when the close note or the key result's own claimed
 * evidence names a live check, else met, unverified.
 */
export function statusAtClose(closeNote: string, ownEvidence: string): Extract<KeyResultStatus, "met" | "met-unverified"> {
  return namesLiveCheck(closeNote) || namesLiveCheck(ownEvidence) ? "met" : "met-unverified";
}
