-- Manager forks step 4 (design note dc_mymt27yz25 §5, §6): building-owned topic pages. A wiki page with topicOf (a
-- building id) is a topic page: published in that building, rewritable by its manager and the manager's live forks.
-- Every rewrite keeps the old body in doc_revisions (authorId = who wrote that body, replacedBy = who rewrote it).
-- An assignment can carry up to 3 attached topic pages (JSON array of doc ids) for its fork's memory block.
ALTER TABLE docs ADD COLUMN topicOf TEXT;
CREATE INDEX docs_topic ON docs(topicOf, type);
CREATE TABLE doc_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  docId TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  authorId TEXT NOT NULL,
  replacedBy TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE INDEX doc_revisions_doc ON doc_revisions(docId, id);
ALTER TABLE assignments ADD COLUMN pages TEXT;
