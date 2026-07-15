-- Partial unique index closing the invoke_agent concurrent-provisioning race.
--
-- 0016 added a blanket (tenant, member, template) unique constraint; 0018
-- dropped it because users may add multiple instances of the same shared
-- template from the UI. Invoked subagents are different: invoke_agent's
-- contract is ONE instance per (member, agent definition), and its
-- check-then-insert provisioning is racy without a constraint behind it (two
-- parallel tool calls both miss the lookup and both insert). Scope the
-- uniqueness to the invoked-subagent template key only, so UI-added
-- multi-instance templates stay unconstrained. The key literal must match
-- INVOKE_TEMPLATE_KEY in packages/myra/src/personas/invoke-policy.ts.
--
-- member_agent_instance is workbench-owned (no interchange tables touched).

CREATE UNIQUE INDEX IF NOT EXISTS "member_agent_instance_invoke_uniq"
  ON "member_agent_instance" ("tenant_id", "member_principal_id", "agent_id")
  WHERE "template_key" = 'myra-invoked-subagent';
