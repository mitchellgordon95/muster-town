-- Read / unread on the bulletin board, per signed-in human (Mitchell's flag dc_04q4h8s229): one row per note a user
-- has opened. A note its own author posted counts as read without a row. Taking a note down removes nothing.
CREATE TABLE bulletin_reads (
  userId TEXT NOT NULL, docId TEXT NOT NULL, readAt TEXT NOT NULL,
  PRIMARY KEY (userId, docId)
);
