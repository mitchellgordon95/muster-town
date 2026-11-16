-- The GitHub repo mitchellgordon95/agent-town was renamed mitchellgordon95/muster-town (2026-11-16). The stored
-- `Town.workspace.repoUrl` (meta 'town') still named the old repo while the runtime reads `host.repoUrl` from the
-- checkout's origin (the new name), so `World.repoMode()` said "own" and no manager or fork held town.redeploy
-- (dc_1lsk4v7psx). Rewrite the old name to the new one, keeping the URL's form (scp or https, .git or not).
-- Any other collective's workspace is left alone.
UPDATE meta
SET value = json_set(value, '$.workspace.repoUrl',
  replace(json_extract(value, '$.workspace.repoUrl'), 'mitchellgordon95/agent-town', 'mitchellgordon95/muster-town'))
WHERE key = 'town'
  AND json_extract(value, '$.workspace.repoUrl') IS NOT NULL
  AND json_extract(value, '$.workspace.repoUrl') LIKE '%github.com_mitchellgordon95/agent-town%';
