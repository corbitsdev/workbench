// Hub-side projection freeze for hub-authored inert workflow definitions.
//
// A code-sourced deploy freezes its definition through the sidecar
// probe: the sidecar projects the live definition to inert plain data,
// walks its capability surface, and the hub gates and freezes the
// result onto the definition's version row
// (`@intx/hub-sessions`' workflow-probe-gate). A definition the hub
// authors itself — an agent from the Agents page, a template block —
// is already inert JSON, so no sidecar round-trip exists to ride, and
// the bare `ensureWorkflowDefinitionForAsset` those paths used to call
// left `approved_wire_hash`/`grant_snapshot`/`wire_projection` NULL:
// permanently unlaunchable rows (CL-6447, CL-6439).
//
// This module is the probe's hub-local counterpart, built from the
// same platform primitives: `projectLiveToInert` reifies the parsed
// definition exactly as the probe child does, `walkCapabilities` walks
// the same grant surface against the same built-in director registry a
// closure without `interchange.directors` gets, and
// `createDbFrozenApprovalWriter` persists the same all-or-nothing
// freeze. The approval policy is the self-approve analogue the probe
// gate documents for live-authored definitions: the hub authored the
// content, so the grant surface the walk reports IS the approved set,
// and the hash is computed and frozen in the same process — there is
// no shipped hash to tamper-check.

import { createDefaultDirectorRegistry } from "@intx/agent";
import type { DBExecutor } from "@intx/db";
import { workflowDefinition, workflowDefinitionVersion } from "@intx/db/schema";
import { createDbFrozenApprovalWriter } from "@intx/hub-sessions";
import type { GrantWalkSnapshot } from "@intx/types";
import { WorkflowProjectionDefinition } from "@intx/types/sidecar";
import { computeWireDefinitionHash } from "@intx/types/wire-definition-hash";
import { projectLiveToInert } from "@intx/workflow";
import type { WorkflowDefinition } from "@intx/workflow";
import { walkCapabilities } from "@intx/workflow-deploy";
import type { CapabilityWalkResult } from "@intx/workflow-deploy";
import { and, eq } from "drizzle-orm";
import { type } from "arktype";

// The version `ensureWorkflowDefinitionForAsset` projects for a fresh
// definition — the row every freeze targets. Hand-coupled to
// `@intx/hub-sessions`' own `FROZEN_VERSION` the same way the probe
// gate documents.
const FROZEN_VERSION = "1";

// The load-bearing top-level fields a serialized definition must carry
// for the projector and the walk to operate. The producers are this
// hub's own builders, so this is a sanity gate that fails loud on a
// malformed serialization, not a full re-validation of a shape the
// projector already fails closed on step by step.
const SerializedWorkflowDefinition = type({
  id: "string",
  stepOrder: "string[]",
  steps: "object",
});

/** Everything a freeze persists, computed without touching the DB. */
export type InertDefinitionFreeze = {
  readonly projection: WorkflowProjectionDefinition;
  readonly wireHash: string;
  readonly grants: readonly string[];
  readonly grantSnapshot: GrantWalkSnapshot;
};

function collectDeploymentGrants(walk: CapabilityWalkResult): string[] {
  const grants = new Set<string>();
  for (const declarations of walk.perStep.values()) {
    for (const grant of declarations.grants) {
      grants.add(grant);
    }
  }
  return [...grants].sort();
}

function buildGrantWalkSnapshot(
  walk: CapabilityWalkResult,
  grantRequirements: WorkflowDefinition["grantRequirements"],
): GrantWalkSnapshot {
  const perStep = [...walk.perStep].map(([stepId, declarations]) => ({
    stepId,
    grants: [...declarations.grants],
    grantEffects: Object.fromEntries(declarations.grantEffects),
  }));
  return {
    perStep,
    grantRequirements: [...(grantRequirements ?? [])],
  };
}

/**
 * Project a serialized hub-authored definition to its inert wire form
 * and walk its capability surface — the same reify-hash-walk sequence
 * the sidecar probe child runs, executed hub-locally over a definition
 * that carries no author code. Fails loud on an unresolvable director:
 * the runtime does not re-gate `director:<id>`, so a freeze whose grant
 * set silently omitted one would approve an incomplete manifest.
 */
export async function projectAndWalkInertDefinition(
  workflowJson: string,
): Promise<InertDefinitionFreeze> {
  const parsed = SerializedWorkflowDefinition(JSON.parse(workflowJson));
  if (parsed instanceof type.errors) {
    throw new Error(
      `workflow-freeze: serialized definition is malformed: ${parsed.summary}`,
    );
  }
  // The sanity gate above proves the load-bearing top level; the
  // projector and the walk fail closed on any step whose shape lies.
  // The producer is the hub's own builder, never external input.
  const definition = parsed as unknown as WorkflowDefinition;

  const projection = WorkflowProjectionDefinition.assert(
    projectLiveToInert(definition),
  );
  const wireHash = await computeWireDefinitionHash(projection);

  const walk = walkCapabilities(definition, createDefaultDirectorRegistry());
  if (walk.unresolvedDirectors.length > 0) {
    throw new Error(
      `workflow-freeze: definition ${definition.id} names unresolvable ` +
        `director(s): ${walk.unresolvedDirectors.join(", ")}`,
    );
  }

  return {
    projection,
    wireHash,
    grants: collectDeploymentGrants(walk),
    grantSnapshot: buildGrantWalkSnapshot(walk, definition.grantRequirements),
  };
}

/**
 * Freeze a hub-authored inert definition onto a first-class
 * `workflow_definition` keyed by `(assetId, wireHash)` — the create
 * path. Persists through `createDbFrozenApprovalWriter`, so the ensure
 * and the stamp are one transaction and the row can never exist in the
 * half-frozen state a bare `ensureWorkflowDefinitionForAsset` leaves.
 * The row keeps the schema's `origin: "authored"` default — only a
 * folded run's own deploy demotes the sibling it mints to a per-run
 * record (CL-6452, `@corbits/folded-runs`' `markRunDeployClone`).
 */
export async function freezeInertWorkflowDefinition(
  db: DBExecutor,
  input: { readonly assetId: string; readonly workflowJson: string },
): Promise<{ definitionId: string; wireHash: string }> {
  const frozen = await projectAndWalkInertDefinition(input.workflowJson);
  const persist = createDbFrozenApprovalWriter(db);
  const { definitionId } = await persist({
    assetId: input.assetId,
    approvedWireHash: frozen.wireHash,
    approvedGrants: frozen.grants,
    grantSnapshot: frozen.grantSnapshot,
    projection: frozen.projection,
  });
  return { definitionId, wireHash: frozen.wireHash };
}

/**
 * The freeze surface a definition-authoring package consumes without
 * carrying the DB executor itself: the composition root binds both
 * halves to its one `db` via `createDefinitionFreezer`, and a unit test
 * substitutes a recording stub instead of emulating drizzle's chains.
 */
export type DefinitionFreezer = {
  freeze(input: {
    readonly assetId: string;
    readonly workflowJson: string;
  }): Promise<{ definitionId: string; wireHash: string }>;
  refreeze(input: {
    readonly definitionId: string;
    readonly workflowJson: string;
  }): Promise<{ wireHash: string }>;
};

/** Bind both freeze halves to one executor. */
export function createDefinitionFreezer(db: DBExecutor): DefinitionFreezer {
  return {
    freeze: (input) => freezeInertWorkflowDefinition(db, input),
    refreeze: (input) => refreezeWorkflowDefinitionProjection(db, input),
  };
}

/**
 * Re-freeze an existing definition in place after its asset content
 * changed — the mutable-edit counterpart of
 * `freezeInertWorkflowDefinition`. Workbench treats a hand-authored
 * agent as one definition whose content evolves (instructions edits,
 * skill re-pins), so an edit updates the definition's own `wireHash`
 * and restamps its frozen version row rather than minting a sibling
 * definition per content hash. Also heals rows frozen before the
 * projection was recorded: any save re-runs the full freeze.
 */
export async function refreezeWorkflowDefinitionProjection(
  db: DBExecutor,
  input: { readonly definitionId: string; readonly workflowJson: string },
): Promise<{ wireHash: string }> {
  const frozen = await projectAndWalkInertDefinition(input.workflowJson);
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(workflowDefinition)
      .set({ wireHash: frozen.wireHash })
      .where(eq(workflowDefinition.id, input.definitionId))
      .returning({ id: workflowDefinition.id });
    if (updated.length !== 1) {
      throw new Error(
        `workflow-freeze: expected exactly one definition row for ` +
          `${input.definitionId}, updated ${String(updated.length)}`,
      );
    }
    const stamped = await tx
      .update(workflowDefinitionVersion)
      .set({
        approvedWireHash: frozen.wireHash,
        grantSnapshot: frozen.grantSnapshot,
        wireProjection: frozen.projection,
      })
      .where(
        and(
          eq(workflowDefinitionVersion.definitionId, input.definitionId),
          eq(workflowDefinitionVersion.version, FROZEN_VERSION),
        ),
      )
      .returning({ id: workflowDefinitionVersion.id });
    if (stamped.length !== 1) {
      throw new Error(
        `workflow-freeze: expected exactly one ${FROZEN_VERSION} version ` +
          `row for definition ${input.definitionId}, stamped ` +
          `${String(stamped.length)}`,
      );
    }
  });
  return { wireHash: frozen.wireHash };
}
