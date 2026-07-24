// The single source of the grant surface a workflow deployment authorizes.
//
// These helpers are consumed by BOTH grant delivery paths:
//   1. `workflow-deploy.ts` — per-step `state/grants.json` files in the hub's
//      repo store (interchange supervisor snapshot assembly reads these when
//      no frame grants shadow them).
//   2. `workflow-deploy-config.ts` — the supervisor deploy frame's
//      `HarnessConfig.grants`, which the SIDECAR writes over every step's
//      grants file at spawn (`writeStepGrants` in workflow-host-wiring) and
//      the workflow child's authorize/EffectContext actually evaluates.
//
// Path 2 is the one that decides runtime authorization for native `action`
// effects and agent-step tool calls. It shipped `grants: []` for every
// deployment — so every action step's `EffectContext.perform` evaluated
// against an empty set and threw "action effect ... was not authorized
// (null)" (heartbeat, last30days, gtm-scripts-briefs), regardless of what
// path 1 wrote. Keeping both paths on these shared helpers is what stops
// them from diverging again.

import { generateId } from "@intx/hub-common";
import type { GrantRule } from "@intx/authz";
import type { WorkflowDefinition } from "@intx/workflow";
import type { ToolPackagePin } from "@intx/types/tool-packages";
import { type CapabilityWalkResult } from "@intx/workflow-deploy";
import {
  canonicalToolNamesForPackages,
  toolPackagesForCapabilities,
} from "@workbench/agents";

const TOOL_GRANT_RESOURCE_PREFIX = "tool:";
const EFFECT_GRANT_RESOURCE_PREFIX = "effect:";

// The capability/effect names the walk collects across every step: an agent
// step's `capability:<name>` grants and an action step's `effect:<name>`
// grants folded into one flat name set. `toolPackagesForCapabilities`
// resolves both spellings (bare or canonical) the same way.
export function capabilityNames(walk: CapabilityWalkResult): string[] {
  const names = new Set<string>();
  for (const { grants } of walk.perStep.values()) {
    for (const grant of grants) {
      if (grant.startsWith("capability:")) {
        names.add(grant.slice("capability:".length));
      }
      if (grant.startsWith("effect:")) {
        names.add(grant.slice("effect:".length));
      }
    }
  }
  return [...names];
}

// The capability-name set a deploy authorizes its step agents for: the
// declared per-step names UNIONED with the full canonical tool surface of the
// staged packages. Declaring one tool from a package stages the whole
// package's definitions in front of every step's model — so entitlement to
// call must match entitlement to see, or an undeclared name fails only at
// runtime with nothing at deploy time to catch it. Declared names are kept in
// the union verbatim for the local-runner tools no package backs (mail_*).
export function stepGrantCapabilityNames(
  declared: readonly string[],
  pins: readonly ToolPackagePin[],
): string[] {
  return [...new Set([...declared, ...canonicalToolNamesForPackages(pins)])];
}

// Build the on-disk `GrantRule` set that authorizes a step agent to invoke
// each of its tools AND, for a native `action` step, to perform each of its
// declared effects. Emitting BOTH a `tool:<name>` and an `effect:<name>`
// allow rule for every name is required, not redundant: an action step's
// `EffectContext.perform` authorizes `effect:<capability>`, which a
// `tool:`-only grants file never satisfies; an agent-step tool call
// authorizes `tool:<name>` and never reads the `effect:` rule.
export function buildStepGrantRules(
  capabilityNames: readonly string[],
): GrantRule[] {
  const unique = [...new Set(capabilityNames)];
  return unique.flatMap((name) => [
    {
      id: generateId("grant"),
      resource: `${TOOL_GRANT_RESOURCE_PREFIX}${name}`,
      action: "invoke",
      effect: "allow" as const,
      origin: "system" as const,
      conditions: null,
      expiresAt: null,
      roleId: null,
      principalId: null,
    },
    {
      id: generateId("grant"),
      resource: `${EFFECT_GRANT_RESOURCE_PREFIX}${name}`,
      action: "invoke",
      effect: "allow" as const,
      origin: "system" as const,
      conditions: null,
      expiresAt: null,
      roleId: null,
      principalId: null,
    },
  ]);
}

// Defensive collector over a definition reconstructed from persisted JSON:
// an agent-bearing primitive (step/map) contributes its declared
// `capabilities`; an action contributes its `effect.requires`; a loop's
// inline body recurses. Deliberately NOT interchange's `walkCapabilities` —
// the walk assumes the full authored shape (toolFactories, inference,
// triggers) and crashes on the persisted-JSON definitions the frame builder
// legitimately receives (the same defensiveness `pickFrameStepSource`
// practices). Trigger-derived mail grants are out of scope here: this feeds
// tool/effect name expansion only.
export function declaredCapabilityNames(
  definition: WorkflowDefinition,
): string[] {
  const names = new Set<string>();
  type PrimitiveRecord = {
    agent?: { capabilities?: readonly string[] };
    effect?: { requires?: readonly string[] };
    body?: WorkflowDefinition;
    step?: PrimitiveRecord;
  };
  const visitPrimitive = (record: PrimitiveRecord): void => {
    for (const capability of record.agent?.capabilities ?? []) {
      names.add(capability);
    }
    for (const required of record.effect?.requires ?? []) {
      names.add(required);
    }
    // A MapPrimitive carries its agent on the INNER step (`step.agent`), not
    // at the primitive's top level — mirror interchange's `extractAgent`,
    // which special-cases kind "map" the same way. Missing this dropped every
    // map-only tool package from the frame grants.
    if (record.step !== undefined) visitPrimitive(record.step);
    if (record.body !== undefined) visit(record.body);
  };
  const visit = (def: WorkflowDefinition | undefined): void => {
    const steps = def?.steps ?? {};
    for (const primitive of Object.values(steps)) {
      if (primitive === undefined || primitive === null) continue;
      visitPrimitive(primitive as PrimitiveRecord);
    }
  };
  visit(definition);
  return [...names];
}

/**
 * The full grant-rule set a deployment's supervisor frame must carry for the
 * given definition: collect declared capability/effect names, expand to the
 * staged packages' canonical surface, emit tool:/effect: allow rules. This
 * is what lands in `HarnessConfig.grants` and therefore in every step's
 * sidecar-side `state/grants.json`.
 */
export function frameGrantRules(definition: WorkflowDefinition): GrantRule[] {
  const declared = declaredCapabilityNames(definition);
  const pins = toolPackagesForCapabilities(declared);
  return buildStepGrantRules(stepGrantCapabilityNames(declared, pins));
}
