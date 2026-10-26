-- Who may interact (Mitchell's flag dc_hsdvn0h5ho, design dc_f0cumcfubk): a signed-in visitor is read-only until an
-- admin lets them in as `member`. They ask once from the guest card; the request waits in the Town Hall in-tray.
CREATE TABLE access_requests (
  id TEXT PRIMARY KEY, userId TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
  decidedBy TEXT, createdAt TEXT NOT NULL, decidedAt TEXT
);
CREATE INDEX access_requests_user ON access_requests(userId, createdAt);
CREATE INDEX access_requests_status ON access_requests(status, createdAt);
