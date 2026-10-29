-- Presentation mode (gr_jh0lu0w6yj step 5, design dc_y7a8g257of §1/§3): the deck a meeting presents above its chat,
-- {docId, slide, presenterId} as JSON; docId is a deck doc or the literal "review-deck" (computed, not stored). NULL = chat.
ALTER TABLE meetings ADD COLUMN deck TEXT;
