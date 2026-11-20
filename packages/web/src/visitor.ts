/**
 * The join funnel's visitor id (gr_zoo2cf2zpp): a random id this browser keeps in localStorage and sends with the guest-card
 * and homepage pings, so the server counts the browser once per UTC day (`guestVisitors`, `homeViews`) instead of every
 * page load. The server keeps only its sha256; it names nobody. A private window gets a fresh one each time; no storage = no id.
 */
const KEY = "muster.visitor";

export function visitorId(): string | null {
  try {
    const had = localStorage.getItem(KEY);
    if (had) return had;
    const id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
    return id;
  } catch { return null; }
}

/**
 * Where this page load came from (gr_ox3fmliv9n): the link's ?ref= tag and document.referrer, sent with the first ping of
 * the day. The server keeps only a short label (the tag, or the referrer's host with no path), never the URL.
 */
export function arrivalSource(): { ref?: string; referrer?: string } {
  try {
    const ref = new URLSearchParams(location.search).get("ref") ?? undefined;
    const referrer = document.referrer || undefined;
    return { ...(ref ? { ref } : {}), ...(referrer ? { referrer } : {}) };
  } catch { return {}; }
}
