-- standing rules: a building's manager writes them; every session in the building starts with them.
ALTER TABLE buildings ADD COLUMN rules TEXT NOT NULL DEFAULT '';
