// Caps a spawned child's inherited grants at what the child body itself
// declares, so a parent-held effect:/credential: grant or a bare-name tool:
// collision never authorizes a capability the child was never written to use.

import type { DirectorRegistry } from "@intx/agent";
import { matchPattern } from "@intx/authz";
import type { WorkflowDefinition } from "@intx/workflow";
import { walkCapabilities, type PluginToolDefinitions } from "@intx/workflow-deploy";

/** Pass the pre-rewrite definition: the walk skips a { ref } body, so a rewritten one would drop grandchild resources. */
export function collectDeclaredResources(
  definition: WorkflowDefinition,
  directors: DirectorRegistry,
  pluginDefs: PluginToolDefinitions,
): ReadonlySet<string> {
  const walk = walkCapabilities(definition, directors, pluginDefs);
  const declared = new Set<string>();
  for (const step of walk.perStep.values()) {
    for (const grant of step.grants) {
      declared.add(grant);
    }
  }
  return declared;
}

/**
 * Only ever removes parent rules, erring toward keeping since dropping is the
 * only unsafe direction: deny/ask are kept unconditionally (dropping an ask
 * floor would punch through an approval gate), an allow is kept only if its
 * pattern covers a declared resource, and action is deliberately not part of
 * the coverage test since evaluateGrants re-gates on it at decision time.
 */
export function filterGrantsToDeclaredResources(
  parentGrants: readonly unknown[],
  declared: ReadonlySet<string>,
): readonly unknown[] {
  return parentGrants.filter((grant) => keepGrantForDeclared(grant, declared));
}

function keepGrantForDeclared(grant: unknown, declared: ReadonlySet<string>): boolean {
  if (!isAllowRuleWithResource(grant)) {
    return true;
  }
  for (const resource of declared) {
    if (matchPattern(grant.resource, resource)) {
      return true;
    }
  }
  return false;
}

function isAllowRuleWithResource(grant: unknown): grant is { effect: "allow"; resource: string } {
  if (typeof grant !== "object" || grant === null) {
    return false;
  }
  if (!("effect" in grant) || !("resource" in grant)) {
    return false;
  }
  return grant.effect === "allow" && typeof grant.resource === "string";
}
