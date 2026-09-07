-- WORKBENCH DELTA (see VENDORED.md): upstream b977ade6 named the opt-in
-- onTrigger body-failure policy "tolerate"; workbench's earlier vendored
-- delta had called the same policy "continue". A frozen inert projection
-- is stored verbatim, so rewrite the retired literal in place. Postgres
-- renders jsonb text canonically (`"key": "value"`), so the textual
-- replace matches exactly this key/value pair at any nesting depth.
UPDATE "workflow_definition_version"
SET "wire_projection" = replace("wire_projection"::text, '"onBodyFailure": "continue"', '"onBodyFailure": "tolerate"')::jsonb
WHERE "wire_projection"::text LIKE '%"onBodyFailure": "continue"%';
