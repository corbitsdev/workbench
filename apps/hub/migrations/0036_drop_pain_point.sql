-- CL-2669 Phase 4: drop the dead pain_point table and the artifact provenance
-- columns that only ever pointed at it.
--
-- Data-safe: pain_point has zero inserts anywhere in the codebase, and
-- artifact.session_id / artifact.pain_point_id are always null (the
-- `sessionId: context.sessionId` occurrences write to the `source` JSONB
-- provenance, never these columns). This is an irreversible historical-data
-- drop, explicitly approved.
--
-- Drop the artifact.pain_point_id column first: it carries the last remaining
-- foreign key onto pain_point, so removing the column clears the FK before the
-- table drop.
ALTER TABLE "artifact" DROP COLUMN IF EXISTS "session_id";
--> statement-breakpoint
ALTER TABLE "artifact" DROP COLUMN IF EXISTS "pain_point_id";
--> statement-breakpoint
DROP TABLE IF EXISTS "pain_point";
