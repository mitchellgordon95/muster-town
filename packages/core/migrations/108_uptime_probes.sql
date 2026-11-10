-- Public uptime (grant gr_rcj8nkbkbt, kr_6ofa7wf812): one row per probe minute per outside source (the 60 s pinger).
-- POST /api/uptime/probes (permission town.uptime) writes it; a repeat of a minute is ignored. GET /api/uptime reads it.
CREATE TABLE uptime_probes (
  minute     TEXT NOT NULL,              -- the probe's UTC minute, 'YYYY-MM-DDTHH:MM'
  source     TEXT NOT NULL,              -- who probed, e.g. 'pinger'
  ok         INTEGER NOT NULL,           -- 1 = health answered ok, 0 = it did not
  ms         INTEGER,                    -- response time, null when none
  receivedAt TEXT NOT NULL,              -- when the town got it (a probe buffered during an outage lands later)
  PRIMARY KEY (minute, source)
);
