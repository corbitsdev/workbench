-- Add per-step credential/tool assignments to workbench_workflows.
-- Captured when a workflow is added to a workbench so each step resolves its
-- assigned tenant credential(s) and tools at run time. Shape:
-- Record<stepName, { credentialIds: string[]; toolIds: string[] }>.
ALTER TABLE "workbench_workflows" ADD COLUMN IF NOT EXISTS "assignments" jsonb;
