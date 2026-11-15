-- The human's screen time on decision-queue items (grant gr_pdja05z2f1 step 1: queue health, how much of the human's
-- time each ask costs). The queue PUTs the item on screen as its 1:1's focus (core meeting-focus.ts); each change
-- closes the human's open view in that 1:1 and opens a new one; null and the 1:1's end close it. A view left open
-- (tab closed, no null sent) keeps closedAt NULL: the reads cap it at 30 minutes, it is never rewritten.
CREATE TABLE screen_views (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  userId    TEXT NOT NULL,
  kind      TEXT NOT NULL,        -- the focus kind: ask, grant, retainer, captain, access, goalProposal, doc, blocked
  itemId    TEXT NOT NULL,
  meetingId TEXT NOT NULL,        -- the 1:1 whose focus it was
  openedAt  TEXT NOT NULL,
  closedAt  TEXT                  -- null while open (or left open)
);
CREATE INDEX screen_views_open ON screen_views(meetingId, userId, closedAt);
CREATE INDEX screen_views_opened ON screen_views(openedAt);
