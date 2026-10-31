-- Post-mortem 2026-10-30 (1:1 mt_x40qq8poc3): the Bank books the credential it actually handed a session, not the plan.
-- The Bank input whose credential the session ran on: the subscription input for its token, the api-key input for its key.
-- NULL = a donor's key (users.apiKey) or a session from before this migration.
ALTER TABLE sessions ADD COLUMN credentialInputId TEXT;
