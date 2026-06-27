-- CL-2413: durable agent memory is one row per owning member principal.
-- A partial unique index makes that an invariant so concurrent first-saves
-- upsert onto the same row instead of forking into duplicate memory rows.
-- Scoped to kind = 'memory' so it never constrains other artifact kinds.

CREATE UNIQUE INDEX IF NOT EXISTS "artifact_memory_per_owner_uniq" ON "artifact" USING btree ("tenant_id","owner_principal_id") WHERE "artifact"."kind" = 'memory';
