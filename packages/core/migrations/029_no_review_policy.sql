-- Who works a building's in-tray is no longer a setting (town hall 2026-10-24, decision 1a): the manager agent
-- (`managerAgentId`) works it when the building has one, else the humans do. `reviewer` and `auto` were never used.
ALTER TABLE buildings DROP COLUMN reviewPolicy;
