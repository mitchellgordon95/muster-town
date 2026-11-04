-- A schedule may name who takes its runs (Secretary step 2, gr_kdlogzzo5s; design dc_8gbluwrdgi §2): a resident of the
-- building, on its own queue. NULL (every schedule so far) = the building queue, a fork of the manager runs it.
ALTER TABLE schedules ADD COLUMN takerId TEXT;
