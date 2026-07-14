-- CL-3577 review fix (B): closes the Granola call-pipeline TOCTOU (SELECT
-- check-then-INSERT with no DB backstop, so two racing ticks/replicas can both
-- pass the existence check and both burn an LLM call + insert a duplicate
-- artifact). Mirrors the `task.source_ref` pattern (0049_task.sql): a nullable
-- text column, backfilled null for every existing row, with a partial unique
-- index so only rows that carry a source_ref are deduped. Pipeline artifacts
-- set `granola:call:<noteId>`; every other artifact kind keeps source_ref
-- null and is untouched by the constraint.

ALTER TABLE "artifact"
  ADD COLUMN IF NOT EXISTS "source_ref" text;

CREATE UNIQUE INDEX IF NOT EXISTS "artifact_tenant_source_ref_uniq"
  ON "artifact" ("tenant_id", "source_ref")
  WHERE "source_ref" IS NOT NULL;
