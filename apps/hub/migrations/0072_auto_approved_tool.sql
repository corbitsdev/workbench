-- A member's durable "auto-approve this tool for me" decision (the three-button
-- approval card's "Auto Approve Always"). A recorded row excludes the tool from
-- the approval-gated ask set for the instance principal, so its grant mints
-- `effect: "allow"` instead of `ask` and the tool no longer suspends for human
-- approval. Keyed on the agent-instance principal (what the grant mint keys on),
-- attributed to the member principal who made the decision. Deleting a row
-- reverts the tool to `ask` on the next grant reconcile. Workbench-owned only.

CREATE TABLE IF NOT EXISTS "auto_approved_tool" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "tool_name" text NOT NULL,
  "created_by_principal_id" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "auto_approved_tool_principal_tool_uniq"
  ON "auto_approved_tool" (
    "tenant_id",
    "principal_id",
    "tool_name"
  );
