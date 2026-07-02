import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "arktype";
import { eq } from "drizzle-orm";
import { schema as intxSchema, getAncestorChain } from "@intx/db";
import { getLogger } from "@intx/log";
import type { WorkflowDefinition } from "@intx/workflow";
import type { AgentRepoStore } from "@intx/hub-sessions";
import type { WorkflowAutopublishMap } from "../config";
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
  return ids;
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
// published into the tenant it must run in. Idempotent (skips a def whose
// published fingerprint already matches) and fail-safe (a per-(kind,tenant)
// failure is logged and skipped — never throws, so a bad def can't block hub
// startup; the last-good published def keeps serving). Descendant workbenches
// inherit via the tenant ancestor chain.
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
    const unchangedForKind =
      current !== null &&
      definitionFingerprint(current) ===
        definitionFingerprint(embedded.definition);

    const targets = await resolveTargetTenantIds(deps, embedded.kind);
    for (const targetTenantId of targets) {
      try {
        if (unchangedForKind) {
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
