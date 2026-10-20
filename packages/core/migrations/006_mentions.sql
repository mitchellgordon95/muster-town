-- mentions: a mention message links to the doc it was made in.
ALTER TABLE messages ADD COLUMN docId TEXT;
