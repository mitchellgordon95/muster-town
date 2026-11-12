-- Asks are snapshots of a job's thread (plan dc_uwx045472m step 6; Mitchell, 2026-11-12: "asks [are] data ... rendered
-- from a thread at a given snapshot of its state"). Every ask points at the entry that raised it, and records the
-- thread's length when its card was last written, so a card whose thread has moved since can be told and re-rendered.
-- Both are NULL on asks filed before this migration: core/src/asks.ts back-fills sourceEntryId at boot for the ones
-- still live whose entry it can name; renderedSeq stays NULL until the card is next written.
ALTER TABLE asks ADD COLUMN sourceEntryId TEXT;
ALTER TABLE asks ADD COLUMN renderedSeq INTEGER;
CREATE INDEX asks_source_entry ON asks(sourceEntryId);
