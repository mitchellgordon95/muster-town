-- A planted flag stands on the map (Mitchell's flag dc_r40dq3znse): the tile it was planted on ({x,y} JSON), and when
-- and by whom the building's manager walked to it and picked it up. Null on every other doc.
ALTER TABLE docs ADD COLUMN flagPos TEXT;
ALTER TABLE docs ADD COLUMN pickedUpAt TEXT;
ALTER TABLE docs ADD COLUMN pickedUpBy TEXT;
