-- Desk session performance (grant gr_uhh6u39vv9 step 1, kr_4pf0n8q9jl): wall-clock, CPU and steal time per session.
-- Desk sessions post all three from the Machine's /proc/stat; host sessions get wallMs only. NULL = not measured.
ALTER TABLE sessions ADD COLUMN wallMs INTEGER;
ALTER TABLE sessions ADD COLUMN cpuMs INTEGER;
ALTER TABLE sessions ADD COLUMN stealMs INTEGER;
