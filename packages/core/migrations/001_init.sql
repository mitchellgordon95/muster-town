-- Agent Town core schema v1. Tables mirror @agent-town/schema objects one-to-one.
-- Nested fields are JSON text columns. Column names match schema field names.

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT NOT NULL,
  donatedTokens INTEGER NOT NULL DEFAULT 0, hasApiKey INTEGER NOT NULL DEFAULT 0,
  apiKey TEXT
);

CREATE TABLE roles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, scope TEXT NOT NULL, buildingId TEXT,
  permissions TEXT NOT NULL, builtin INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX roles_building ON roles(buildingId);

CREATE TABLE memberships (
  roleId TEXT NOT NULL, holderKind TEXT NOT NULL, holderId TEXT NOT NULL,
  PRIMARY KEY (roleId, holderKind, holderId)
);
CREATE INDEX memberships_holder ON memberships(holderKind, holderId);

CREATE TABLE buildings (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, goal TEXT, description TEXT,
  headcount INTEGER NOT NULL, reviewPolicy TEXT NOT NULL, model TEXT, cheapModel TEXT,
  maxTurnsPerSession INTEGER, dailyTokensPerAgent INTEGER, meetings TEXT, lot TEXT,
  createdAt TEXT NOT NULL, createdBy TEXT
);

CREATE TABLE allocations (
  id TEXT PRIMARY KEY, userId TEXT NOT NULL, buildingId TEXT NOT NULL, tokens INTEGER NOT NULL,
  spentTokens INTEGER NOT NULL DEFAULT 0, spentUsd REAL NOT NULL DEFAULT 0, createdAt TEXT NOT NULL
);
CREATE INDEX allocations_building ON allocations(buildingId, createdAt);

CREATE TABLE agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, buildingId TEXT, homeBuildingId TEXT,
  ownerUserId TEXT, title TEXT, direction TEXT, sprite INTEGER, pos TEXT NOT NULL, status TEXT NOT NULL,
  activity TEXT, model TEXT, spentTokensToday INTEGER, spentTokensTotal INTEGER, spentUsdTotal REAL,
  currentAssignmentId TEXT, currentMeetingId TEXT, createdAt TEXT NOT NULL, lastActiveAt TEXT
);
CREATE INDEX agents_home ON agents(homeBuildingId);

-- desk occupancy (which resident sits at desk n of a building)
CREATE TABLE desks (
  buildingId TEXT NOT NULL, n INTEGER NOT NULL, agentId TEXT NOT NULL UNIQUE,
  PRIMARY KEY (buildingId, n)
);

CREATE TABLE places (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, buildingId TEXT, pos TEXT NOT NULL);

CREATE TABLE docs (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, state TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  authorId TEXT NOT NULL, authorKind TEXT NOT NULL, buildingId TEXT, provenance TEXT, tags TEXT,
  verdict TEXT, decision TEXT, decisionNote TEXT, decidedBy TEXT, decidedAt TEXT, sessionId TEXT,
  assignmentId TEXT, costUsd REAL, tokens INTEGER, requestStatus TEXT, location TEXT, claimedByUserId TEXT,
  trophyProposedBy TEXT, trophyWhy TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE INDEX docs_building ON docs(buildingId, state, updatedAt);
CREATE INDEX docs_type ON docs(type, state);

CREATE VIRTUAL TABLE docs_fts USING fts5(title, body, content='docs', content_rowid='rowid');
CREATE TRIGGER docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO docs_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER docs_au AFTER UPDATE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO docs_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE TABLE assignments (
  id TEXT PRIMARY KEY, agentId TEXT NOT NULL, buildingId TEXT NOT NULL, title TEXT NOT NULL,
  description TEXT NOT NULL, status TEXT NOT NULL, createdBy TEXT NOT NULL, createdByKind TEXT NOT NULL,
  fromMeetingId TEXT, fromReportId TEXT, reportId TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE INDEX assignments_agent ON assignments(agentId, status);

CREATE TABLE messages (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, fromId TEXT NOT NULL, fromKind TEXT NOT NULL, toId TEXT NOT NULL,
  body TEXT NOT NULL, meetingId TEXT, createdAt TEXT NOT NULL, readAt TEXT
);
CREATE INDEX messages_to ON messages(toId, readAt);

CREATE TABLE meetings (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, buildingId TEXT, title TEXT NOT NULL, scheduledAt TEXT NOT NULL,
  phase TEXT NOT NULL, facilitatorId TEXT, attendeeIds TEXT, agenda TEXT, summaries TEXT, transcript TEXT,
  decisions TEXT, notesDocId TEXT, createdAt TEXT NOT NULL, startedAt TEXT, endedAt TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY, agentId TEXT NOT NULL, assignmentId TEXT, meetingId TEXT, purpose TEXT NOT NULL,
  status TEXT NOT NULL, model TEXT NOT NULL, sdkSessionId TEXT, tokens INTEGER, costUsd REAL, turns INTEGER,
  reportId TEXT, error TEXT, startedAt TEXT NOT NULL, endedAt TEXT
);
CREATE INDEX sessions_agent ON sessions(agentId, startedAt);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, type TEXT NOT NULL, agentId TEXT, buildingId TEXT,
  text TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX events_agent ON events(agentId, id);
CREATE INDEX events_building ON events(buildingId, id);

CREATE TABLE tokens (token TEXT PRIMARY KEY, kind TEXT NOT NULL, id TEXT NOT NULL, createdAt TEXT NOT NULL);
CREATE INDEX tokens_holder ON tokens(kind, id);
