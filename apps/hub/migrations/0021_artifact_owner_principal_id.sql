-- Add nullable owner_principal_id to artifacts (CL-2035).
--
-- Tracks the human owner of each artifact separate from the actor
-- (principalId), which may be a synthetic agent instance principal
-- for agent-created artifacts. The gallery uses this column for
-- filter-by-owner without a multi-table join.

ALTER TABLE "artifact"
  ADD COLUMN IF NOT EXISTS "owner_principal_id" text;
