-- v1.5 logins: users can sign in with GitHub
ALTER TABLE users ADD COLUMN githubLogin TEXT;
ALTER TABLE users ADD COLUMN githubId INTEGER;
ALTER TABLE users ADD COLUMN avatarUrl TEXT;
CREATE UNIQUE INDEX users_github_id ON users(githubId) WHERE githubId IS NOT NULL;
