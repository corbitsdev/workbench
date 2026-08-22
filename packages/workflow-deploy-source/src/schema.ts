// The one table this package owns: one row per anchor run naming the
// deploy-time inputs the hub needs to reissue that run's deploy call
// with no input beyond what Postgres already holds. It lives in its own
// `workflow_deploy_source` Postgres schema, fully siloed from `public` —
// see docs/package-migrations.md — and never reads `workflow_run` or
// `workflow_run_launch_spec` itself, so it never races either.
//
// `source` is `WorkflowDefinitionSource` verbatim — the same discriminated
// union `POST /workflows/deployments` already accepts (`registry` or
// `asset`). A hub-git asset is one arm of that union, not a hardcoded
// shape: nothing here assumes the bytes came from `RepoStore`, so a future
// source arm (a remote git origin, say) needs no new column, just a new
// case inside the same jsonb value.
import { index, jsonb, pgSchema, text, timestamp } from "drizzle-orm/pg-core";

export const workflowDeploySourceSchema = pgSchema("workflow_deploy_source");

export const workflowDeploySource = workflowDeploySourceSchema.table(
  "workflow_deploy_source",
  {
    // The deployment's anchor `workflow_run.id`. One durable source record
    // per deployment: a redeploy or a rotation overwrites this row rather
    // than appending, so a lookup by anchor run id always answers with the
    // current source.
    anchorRunId: text("anchor_run_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    deploymentDomain: text("deployment_domain").notNull(),
    // Where the definition's bytes come from at apply time — the
    // `WorkflowDefinitionSource` union (registry name@range, or an asset
    // commit/tarball in the hub's git-backed store), stored as-is.
    source: jsonb("source").notNull(),
    // The `interchange.workflow` entry-module path the sidecar evaluates.
    entry: text("entry").notNull(),
    // A `name@range` spec for the definition package. Required for the
    // `registry` and asset-`tarball` source variants; null for asset-`source`,
    // whose member is selected by `source.package.packageName` instead.
    pin: text("pin"),
    // The `workflow`-kind asset the deployed definition projects a
    // `workflow_definition` row over.
    definitionAssetId: text("definition_asset_id").notNull(),
    // WORKBENCH DELTA companion (see vendor/intx/hub-sessions
    // `DeployWorkflowFromSourceParams.sourceRef`): the git ref inside the
    // source asset that carries `source.package.commitSha`, when the asset
    // mints a fresh tree per run rather than living on its default ref.
    sourceRef: text("source_ref"),
    // The principal whose grant/catalog authority a redeploy resolves fresh
    // inference sources against. Never a resolved source or a credential —
    // those are re-resolved at redeploy time, exactly as the exclusive
    // placement's launch spec re-resolves from offering ids rather than
    // persisting secrets.
    sourceAuthorityPrincipalId: text("source_authority_principal_id").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("workflow_deploy_source_tenant_idx").on(table.tenantId)],
);

export type WorkflowDeploySourceRow = typeof workflowDeploySource.$inferSelect;
