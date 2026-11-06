-- Outbox requests get two missing moves (Mitchell, 1:1 mt_pr3347g2w2 decision 7): an author withdraws its own open
-- request with a note (a request that replaces an older one withdraws it), and a human declines one (on the button, or
-- through the Secretary in a 1:1, recorded as the human's, via the agent and meeting). The note stays on the request.
ALTER TABLE docs ADD COLUMN requestNote TEXT;
ALTER TABLE docs ADD COLUMN requestDecidedById TEXT;
ALTER TABLE docs ADD COLUMN requestViaAgentId TEXT;
ALTER TABLE docs ADD COLUMN requestViaMeetingId TEXT;
ALTER TABLE docs ADD COLUMN requestReplaces TEXT;
