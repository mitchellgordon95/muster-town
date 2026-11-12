-- Public uptime is measured by UptimeRobot (grant gr_hbz0twkfp9, Mitchell 1:1 mt_msnjkpgwdb): no town agent posts probes,
-- so the town `prober` role (permission town.uptime, never granted) goes. Table uptime_probes (108) stays.
DELETE FROM memberships WHERE roleId = 'role:prober';
DELETE FROM roles WHERE id = 'role:prober';
