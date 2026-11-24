# Invariants: browser errors

What must always hold for browser errors (`packages/core/src/client-errors.ts`, the browser-errors table from `packages/core/migrations/131_client_errors.sql`, routes in `packages/server/src/client-errors.ts`, capture in `packages/web/src/clientErrors.ts` and `packages/web/src/panels/PanelBoundary.tsx`). Grant gr_cyqzweu6ed. The map row is in [docs/architecture.md](../architecture.md#map-the-system-in-10-minutes).

**Citation format** (checked by `npm run check:docs`, see `scripts/check-doc-refs.ts`): each invariant has one or more `- Test:` lines, the test file then the `it` text, copied exactly.

## Invariants

1. **One bug is one kind, deduped by signature.** The signature is the source, the message with ids, numbers, hex and URLs blanked, and the top stack frame without its build hash or line:col. The same bug on another build, doc or id adds one to its kind's count and takes the live commit as its last commit; only a new kind gets a row and a `client.error.new` event, at most 100 new kinds a UTC day.
   - Test: `packages/core/test/client-errors.test.ts` › `property: the signature ignores which id or number an occurrence carried, and stays short`
   - Test: `packages/core/test/client-errors.test.ts` › `counts a known kind, takes the live commit as its last, and appends client.error.new only for a new kind`
   - Test: `packages/core/test/client-errors.test.ts` › `keeps at most MAX_NEW_KINDS_PER_DAY new kinds a UTC day; a known kind still counts`
2. **No user text or identity is stored.** A post keeps only its source, normalized message, top frame, a panel kind from a fixed pattern and the route with ids blanked and its query dropped; quoted text over 40 characters becomes "…"; extra fields (a user id) are dropped; the client IP is used only for the rate limit and never stored or listed.
   - Test: `packages/core/test/client-errors.test.ts` › `blanks ids, numbers, hashes, URLs and long quoted text in a message`
   - Test: `packages/core/test/client-errors.test.ts` › `refuses a post with no known source or no message; keeps only a panel kind and a route with ids blanked`
   - Test: `packages/server/test/client-errors.test.ts` › `records a guest's sendBeacon post (text/plain) with the live commit; a repeat counts, no new kind; GET is public`
3. **`newSinceDeploy` counts the kinds first seen since the running server started.** `GET /api/client-errors` marks each listed kind `newSinceDeploy` when its `firstSeen` is at or after `world.host.startedAt` and gives their number; an unknown start marks none. A parked step checks `GET /api/client-errors /newSinceDeploy 0` after its deploy.
   - Test: `packages/core/test/client-errors.test.ts` › `marks kinds first seen since the running server started, and counts them as newSinceDeploy`
