-- Key results auto-met on close (Mitchell, town hall mt_v09cn7a8yr decision 2): a grant closed as done marks its open key
-- results met itself, so no human met/missed step is left in the Town Hall in-tray. Back-fill: key results still claimed on
-- a grant already closed as done go to met and archive under their goal (statusNote and statusBy, the closer, stay).
UPDATE key_results SET status = 'met', archivedAt = COALESCE(archivedAt, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE status = 'claimed' AND grantId IN (SELECT id FROM grants WHERE status = 'closed' AND outcome = 'done');
