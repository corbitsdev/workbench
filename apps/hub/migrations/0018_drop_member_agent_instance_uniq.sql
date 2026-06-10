-- Drop the one-per-user-per-template unique constraint on member_agent_instance.
--
-- Originally added in 0016 to keep auto-provisioning on join idempotent. The
-- model has changed: users can now explicitly add multiple instances of the
-- same shared agent template from the UI. The constraint blocks that.

ALTER TABLE "member_agent_instance"
  DROP CONSTRAINT IF EXISTS "member_agent_instance_tenant_member_template_uniq";
