-- explicit building manager: the resident a human picked to facilitate meetings (null = none set).
ALTER TABLE buildings ADD COLUMN managerAgentId TEXT;
