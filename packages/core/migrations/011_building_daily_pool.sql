-- a building's daily token pool: residents draw from it as they work, each up to dailyTokensPerAgent; NULL = no daily limit.
ALTER TABLE buildings ADD COLUMN dailyTokens INTEGER;
