/**
 * Browser errors (grant gr_cyqzweu6ed step 1): a panel crash (PanelBoundary's componentDidCatch), an uncaught error or an
 * unhandled rejection is posted to POST /api/client-errors (navigator.sendBeacon, so a page that is closing still sends
 * it), at most MAX_REPORTS_PER_LOAD a page load. It sends the message, the stack, the panel kind and the hash route (the
 * server blanks ids and keeps only the top frame): never who, never what was typed.
 */
import { getApi } from "./api";

export const MAX_REPORTS_PER_LOAD = 10;
export type ClientErrorSource = "panel" | "error" | "rejection";
/** The body POST /api/client-errors takes. */
export interface ClientErrorPost { source: ClientErrorSource; message: string; stack: string; panel: string | null; route: string }

let sent = 0;
/** Tests only: start a fresh page load's count. */
export function resetClientErrorCount() { sent = 0; }

function postOf(source: ClientErrorSource, err: unknown, panel: string | null): ClientErrorPost {
  const e = err instanceof Error ? err : null;
  const message = e ? e.message || e.name : typeof err === "string" ? err : (() => { try { return JSON.stringify(err) ?? String(err); } catch { return String(err); } })();
  return { source, message: message.slice(0, 500), stack: (e?.stack ?? "").slice(0, 2000), panel, route: location.hash.replace(/\?.*$/, "").slice(0, 60) };
}

/** Send one error; past MAX_REPORTS_PER_LOAD this page load, nothing. Never throws. */
export function reportClientError(source: ClientErrorSource, err: unknown, panel: string | null = null): void {
  if (sent >= MAX_REPORTS_PER_LOAD) return;
  sent++;
  try {
    const body = postOf(source, err, panel);
    void getApi().then((a) => a.reportClientError(body)).catch(() => undefined);
  } catch { /* reporting an error must never be one */ }
}

/** Listen for uncaught errors and unhandled rejections on the window. Returns the cleanup. */
export function installErrorHandlers(): () => void {
  const onError = (ev: ErrorEvent) => {
    // a cross-origin script's error carries no detail ("Script error."): nothing to fix from here
    if (!ev.error && (!ev.message || ev.message === "Script error.")) return;
    reportClientError("error", ev.error ?? ev.message);
  };
  const onRejection = (ev: PromiseRejectionEvent) => reportClientError("rejection", ev.reason);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => { window.removeEventListener("error", onError); window.removeEventListener("unhandledrejection", onRejection); };
}
