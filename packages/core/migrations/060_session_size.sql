-- Desk perf step 3 (grant gr_uhh6u39vv9, kr_4pf0n8q9jl): the desk Machine size each session ran on, so Fly cost is priced
-- per session (performance-1x normally, shared-cpu-2x when the day's desk bill is over the cap). NULL = a host session,
-- a docker desk, or a session from before this migration (those ran on shared-cpu-2x, 2048 MB).
ALTER TABLE sessions ADD COLUMN cpuKind TEXT;
ALTER TABLE sessions ADD COLUMN cpus INTEGER;
ALTER TABLE sessions ADD COLUMN memoryMb INTEGER;
