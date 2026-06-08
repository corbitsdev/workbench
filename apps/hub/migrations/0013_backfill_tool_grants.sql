-- Backfill persisted tool grants for existing agent instances.
--
-- Tool grants were previously synthesized in memory at launch and silently
-- dropped on every sidecar reconnect (collectGrants re-sends only DB rows), so
-- reconnected agents failed with "No matching grants for tool:..." (CL-1398).
-- The launch path now persists tool grants, but already-provisioned instances
-- hold no rows until they next relaunch. Backfill from each agent's
-- capabilities.tools so existing instances keep tool access immediately after
-- deploy.
--
-- Idempotent: skips any (principal, tool) already granted, and tolerates a
-- missing or non-array capabilities.tools.
INSERT INTO "grant" (
  id,
  tenant_id,
  role_id,
  principal_id,
  resource,
  action,
  effect,
  conditions,
  origin,
  expires_at,
  created_at,
  updated_at
)
SELECT
  'grt_' || replace(gen_random_uuid()::text, '-', ''),
  ai.tenant_id,
  NULL,
  ai.principal_id,
  'tool:' || tool,
  'invoke',
  'allow',
  NULL,
  'system',
  NULL,
  now(),
  now()
FROM agent_instance ai
JOIN agent a ON a.id = ai.agent_id
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE
    WHEN jsonb_typeof(a.capabilities -> 'tools') = 'array' THEN a.capabilities -> 'tools'
    ELSE '[]'::jsonb
  END
) AS tool
WHERE NOT EXISTS (
  SELECT 1
  FROM "grant" g
  WHERE g.principal_id = ai.principal_id
    AND g.resource = 'tool:' || tool
    AND g.action = 'invoke'
    AND g.origin = 'system'
);
