-- WORKBENCH DELTA (see VENDORED.md, CL-6452): distinguish the hub-authored
-- workflow_definition (the row agent edits refreeze in place) from the
-- same-named siblings every code-sourced run deploy ensures over the same
-- asset under its per-run wire hash. Resolution used to walk siblings
-- newest-first by NAME, so the newest run clone's stale frozen projection
-- shadowed every hub-authored edit after an agent's first run.
--
-- Backfill: the hub-authored row is always the first definition minted for
-- its asset (agent creation freezes it before any run can deploy), so the
-- earliest row per (tenant_id, asset_id) is marked "authored" and every
-- later sibling stays a "run" clone. Rows with no asset predate the
-- asset-keyed model and have no run clones, so they are all "authored".
ALTER TABLE "workflow_definition" ADD COLUMN "origin" text DEFAULT 'run' NOT NULL;--> statement-breakpoint
UPDATE "workflow_definition" SET "origin" = 'authored' WHERE "asset_id" IS NULL;--> statement-breakpoint
UPDATE "workflow_definition" AS d
SET "origin" = 'authored'
FROM (
  SELECT DISTINCT ON ("tenant_id", "asset_id") "id"
  FROM "workflow_definition"
  WHERE "asset_id" IS NOT NULL
  ORDER BY "tenant_id", "asset_id", "created_at" ASC, "id" ASC
) AS first_per_asset
WHERE d."id" = first_per_asset."id";
