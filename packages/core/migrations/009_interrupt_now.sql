-- interrupts: `now` = abort the agent's current turn and deliver at once (otherwise it waits for the next turn boundary).
ALTER TABLE interrupts ADD COLUMN now INTEGER NOT NULL DEFAULT 0;
