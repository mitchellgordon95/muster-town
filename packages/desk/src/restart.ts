/**
 * Riding out a town restart (docs/architecture.md "Redeploy"): a redeploy restarts the server while desk
 * sessions keep running, so for a few seconds the town refuses connections (the process is down), its proxy answers
 * 502/504, or the exiting server answers 503 `{ restarting: true }` with Retry-After. A request that got one of those
 * never ran, so it is safe to send again.
 */

/** Waits between attempts while the town restarts: 1, 2, 4, 8, 15, then 30 s, about 4.5 min in all. */
export const RESTART_BACKOFF_MS = [1000, 2000, 4000, 8000, 15_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000];

/** An HTTP status that means the request never reached a running town. */
export const restarting = (status: number): boolean => status === 502 || status === 503 || status === 504;
