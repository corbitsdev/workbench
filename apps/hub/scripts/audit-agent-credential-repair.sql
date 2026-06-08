-- Run against production before deleting the repair pass (CL-1374)
-- Returns agent rows that would still need repair: missing credential_requirements or model_config.
SELECT id, agent_id, tenant_id
FROM agent
WHERE credential_requirements IS NULL
   OR credential_requirements = '[]'::jsonb
   OR model_config IS NULL;
