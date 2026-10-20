-- v1.4 visitor presence: last authenticated call, and assignments to visitors are offers
ALTER TABLE agents ADD COLUMN lastSeenAt TEXT;
ALTER TABLE assignments ADD COLUMN offered INTEGER;
