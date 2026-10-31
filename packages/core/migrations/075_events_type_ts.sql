-- Post-mortem 2026-10-31 (503s), suggestion 4: every time-window query on events filters on type and ts together
-- (EventLog.list with `types` + `from`: bank cap/hold scans, reconcile, stopOverdueForks' stopFork scan, the manager
-- prompt's recent decisions; skill.used counts). The only type index was (type, id), so SQLite walked every row of the
-- type and loaded it to test ts. (type, ts) lets it range-scan just the window. Additive: one new index.
CREATE INDEX events_type_ts ON events(type, ts);
