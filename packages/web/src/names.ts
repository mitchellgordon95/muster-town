/**
 * Names of agents and users that are not in the snapshot (retired forks, dismissed or banned agents), so docs keep a
 * readable author. Filled when an agent leaves the snapshot, by GET /api/docs/:id's resolved `author`, and by the lazy
 * GET /api/agents/:id lookup in `nameOf`. Its own module so the api client can fill it without importing the store.
 */
export const knownNames = new Map<string, string>();
