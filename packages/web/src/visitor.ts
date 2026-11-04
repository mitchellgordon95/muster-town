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
