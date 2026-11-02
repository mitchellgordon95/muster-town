-- The root goal always has a captain (1:1 mt_cyd2t5ioob, decision 7): routing has no "the town admins" fallback any more.
-- Back-fill a root with no captain with the collective's first admin user: the earliest admin with a GitHub account
-- (on muster.town, Mitchell), else the earliest admin (a fresh collective's seeded admin). Goals.ensure() repeats this at
-- every boot, so a town whose admin is made after the migrations still gets one. A root already captained is untouched.
UPDATE goals SET ownerId = (
  SELECT m.holderId FROM memberships m JOIN users u ON u.id = m.holderId
  WHERE m.roleId = 'role:admin' AND m.holderKind = 'user'
  ORDER BY (u.githubId IS NULL), m.rowid LIMIT 1
)
WHERE id = 'gl_town' AND ownerId IS NULL;
