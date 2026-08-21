-- WORKBENCH DELTA (see VENDORED.md, CL-6452): separate a workflow_definition
-- that is a definition in its own right from the per-run record of one deploy.
-- A folded run's deployed bytes carry per-run values, so their wire hash is
-- unique to the run and the deploy's freeze ensures a fresh same-named sibling
-- over the agent's asset. Launch resolution used to walk deployed siblings
-- newest-first by NAME, so the newest such record's stale frozen projection
-- shadowed every hub-authored edit (skill pins, instruction saves) after an
-- agent's first run.
--
-- Backfill: an agent's own definition is always the first row minted for its
-- asset -- the create-path freeze (or a native deploy) precedes any run that
-- could deploy from it -- so the earliest row per (tenant_id, asset_id) keeps
-- the "authored" default and every later sibling becomes a per-run record.
-- Rows with no asset predate the asset-keyed model and have no per-run
-- siblings, so they are all authored.
ALTER TABLE "workflow_definition" ADD COLUMN "origin" text DEFAULT 'authored' NOT NULL;--> statement-breakpoint
UPDATE "workflow_definition" AS d
SET "origin" = 'run'
WHERE d."asset_id" IS NOT NULL
  AND d."id" <> (
    SELECT first_row."id"
    FROM "workflow_definition" AS first_row
    WHERE first_row."tenant_id" = d."tenant_id"
      AND first_row."asset_id" = d."asset_id"
    ORDER BY first_row."created_at" ASC, first_row."id" ASC
    LIMIT 1
  );
