import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "arktype";
import { and, eq, isNull } from "drizzle-orm";
import { schema as intxSchema, getAncestorChain } from "@intx/db";
import { getLogger } from "@intx/log";
import type { WorkflowDefinition } from "@intx/workflow";
import type { AgentRepoStore } from "@workbench/hub-sessions";
import type { WorkflowAutopublishMap } from "../config";
import { workflowRun } from "../db/schema";
import {
  type WorkflowDeployCoreDeps,
  NoDeployingPrincipalError,
  publishWorkflowDefinition,
} from "../routes/workflow-deploy";
import { readWorkflowDefinition } from "./workflow-deploy";
import {
  EmbeddedWorkflowDefSchema,
  definitionFingerprint,
  embeddedWorkflowDefsDir,
} from "../lib/workflow-defs-embedded";

const log = getLogger(["services", "workflow-defs-bootstrap"]);

export interface WorkflowDefsBootstrapDeps {
  coreDeps: WorkflowDeployCoreDeps;
  repoStore: AgentRepoStore;
  // Gate (CL-2593): when false this is a no-op. From config.workflowAutopublishOnBoot.
  enabled: boolean;
  // The hub's build SHA, stamped into the deploy meta so the catalog shows the
  // version that auto-published. Null in local dev.
  buildSha: string | null;
  // Override the committed-defs directory (tests point this at fixtures).
  // Defaults to the bundled `apps/hub/generated/workflow-defs`.
  defsDir?: string;
  // Per-kind → tenant-slug routing (CL-2641). Null/omitted → every def targets
  // the global root tenant (back-compat with CL-2593).
  autopublishMap?: WorkflowAutopublishMap | null;
}

// Resolve the tenant ids a def of `kind` should publish into. With no map,
// every def targets the root tenant (exact pre-CL-2641 behavior). With a map,
// the target slugs are `map[kind] ?? map["default"] ?? [rootTenant]`. Each slug
// is resolved to a tenant id and validated to be the global tenant or a
// descendant (reusing the deploy route's ancestor-chain check); an unknown or
// out-of-hierarchy slug is logged and dropped so the other targets still
// publish. Never throws.
async function resolveTargetTenantIds(
  deps: WorkflowDefsBootstrapDeps,
  kind: string,
): Promise<string[]> {
  const map = deps.autopublishMap;
  if (map === undefined || map === null) return [deps.coreDeps.rootTenantId];
  const slugs = map[kind] ?? map["default"];
  if (slugs === undefined) return [deps.coreDeps.rootTenantId];

  const ids: string[] = [];
  for (const slug of slugs) {
    const tenant = await deps.coreDeps.db.query.tenant.findFirst({
      where: eq(intxSchema.tenant.slug, slug),
      columns: { id: true },
    });
    if (!tenant) {
      log.error("autopublish-map slug resolves to no tenant; skipping target", {
        kind,
        slug,
      });
      continue;
    }
    const ancestors = await getAncestorChain(deps.coreDeps.db, tenant.id);
    if (!ancestors.includes(deps.coreDeps.rootTenantId)) {
      log.error(
        "autopublish-map target is not the global tenant or a descendant; skipping target",
        { kind, slug },
      );
      continue;
    }
    ids.push(tenant.id);
  }
  // De-dup so a slug listed twice (or two slugs resolving to the same tenant)
  // does not publish + supersede the same (kind, tenant) twice in one boot.
  return [...new Set(ids)];
}

// Whether `tenantId` currently has an active (non-deleted) deployment of `kind`.
// The git-backed workflow repo is keyed by KIND ONLY (readWorkflowDefinition →
// getRepoDir({ kind: "workflow", id: kind })), so its fingerprint is
// tenant-independent and cannot answer "does THIS tenant have the def". The
// per-tenant signal is the deployment-index row (`workflow_run`), which
// publishWorkflowDefinition writes per (kind, tenant) and supersede soft-deletes
// per (kind, tenant). Without this a kind already published to tenant A would be
// skipped for a newly-mapped tenant B on the next boot (matching per-kind
// fingerprint), and B would never receive the def. (CL-2641.)
async function tenantHasActiveDeployment(
  deps: WorkflowDefsBootstrapDeps,
  kind: string,
  tenantId: string,
): Promise<boolean> {
  const row = await deps.coreDeps.db.query.workflowRun.findFirst({
    where: and(
      eq(workflowRun.kind, kind),
      eq(workflowRun.tenantId, tenantId),
      isNull(workflowRun.deletedAt),
    ),
    columns: { id: true },
  });
  return row !== undefined && row !== null;
}

async function loadEmbeddedDefs(
  dir: string,
): Promise<(typeof EmbeddedWorkflowDefSchema.infer)[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    // No generated dir (e.g. `build:workflow-defs` was never run) — nothing to publish.
    return [];
  }
  const defs: (typeof EmbeddedWorkflowDefSchema.infer)[] = [];
  for (const file of files.sort()) {
    try {
      const parsed = EmbeddedWorkflowDefSchema(
        JSON.parse(await readFile(join(dir, file), "utf8")),
      );
      if (parsed instanceof type.errors) {
        log.error("embedded workflow def is invalid; skipping", {
          file,
          error: parsed.summary,
        });
        continue;
      }
      defs.push(parsed);
    } catch (err) {
      log.error("failed to read embedded workflow def; skipping", {
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return defs;
}

// Publish the build-serialized workflow definitions on boot (CL-2593). By
// default every def goes to the global root tenant; an optional autopublishMap
// (CL-2641) routes specific kinds to specific tenants by slug so a workflow is
// published into the tenant it must run in. Idempotent per (kind, tenant) — a
// pair is skipped only when the per-kind repo fingerprint matches AND that
// tenant already has an active deployment of the kind, so a newly-mapped tenant
// still receives a def whose fingerprint is otherwise unchanged. Fail-safe (a
// per-(kind,tenant) failure is logged and skipped — never throws, so a bad def
// can't block hub startup; the last-good published def keeps serving). A def
// that resolves to zero target tenants is warned about loudly (published
// nowhere is the most dangerous outcome). Descendant workbenches inherit via the
// tenant ancestor chain.
export async function publishEmbeddedWorkflowDefs(
  deps: WorkflowDefsBootstrapDeps,
): Promise<void> {
  if (!deps.enabled) {
    log.info("workflow autopublish-on-boot disabled; skipping");
    return;
  }
  const defs = await loadEmbeddedDefs(
    deps.defsDir ?? embeddedWorkflowDefsDir(),
  );
  let published = 0;
  let unchanged = 0;
  let skipped = 0;
  let skippedOnError = 0;
  for (const embedded of defs) {
    const current = await readWorkflowDefinition(
      deps.repoStore,
      embedded.kind,
    ).catch(() => null);
    // Idempotency relies on deployWorkflow persisting the envelope such that
    // the read-back fingerprint equals the embedded one (both pass through
    // workflowDefinitionEnvelopeSchema). If it ever republishes a def on
    // every boot (published>0 with no "unchanged"), that seam has drifted —
    // visible in these logs on the staging rollout before prod. (CL-2593.)
    const fingerprintMatches =
      current !== null &&
      definitionFingerprint(current) ===
        definitionFingerprint(embedded.definition);

    const targets = await resolveTargetTenantIds(deps, embedded.kind);
    if (targets.length === 0) {
      log.warn("workflow def resolved to no target tenant; not published", {
        kind: embedded.kind,
      });
      continue;
    }
    for (const targetTenantId of targets) {
      try {
        // Skip only when the def is unchanged AND this tenant already holds it;
        // a matching per-kind fingerprint alone is not enough (a newly-mapped
        // tenant has no deployment row yet and must still receive the def).
        if (
          fingerprintMatches &&
          (await tenantHasActiveDeployment(deps, embedded.kind, targetTenantId))
        ) {
          unchanged += 1;
          continue;
        }
        await publishWorkflowDefinition(deps.coreDeps, {
          // Same exactOptional cast the deploy route uses — the envelope
          // schema's optional `state` widens differently than WorkflowDefinition.
          definition: embedded.definition as WorkflowDefinition,
          targetTenantId,
          deployMeta: {
            version: embedded.version,
            sha: deps.buildSha ?? "unknown",
            deployedAt: new Date().toISOString(),
            ...(embedded.label !== undefined ? { label: embedded.label } : {}),
            ...(embedded.description !== undefined
              ? { description: embedded.description }
              : {}),
          },
        });
        published += 1;
      } catch (err) {
        // A tenant with no user principal yet (e.g. a fresh global tenant
        // before the owner is seeded) is an expected race, not an error — skip
        // quietly so it doesn't page through the error-only Sentry sink.
        if (err instanceof NoDeployingPrincipalError) {
          skipped += 1;
          log.info("no deploying principal yet; skipping def on boot", {
            kind: embedded.kind,
            tenantId: targetTenantId,
          });
          continue;
        }
        skippedOnError += 1;
        log.error("failed to auto-publish workflow def on boot; skipping", {
          kind: embedded.kind,
          tenantId: targetTenantId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  log.info("workflow autopublish-on-boot complete", {
    published,
    unchanged,
    skipped,
    skippedOnError,
    total: defs.length,
  });
}
