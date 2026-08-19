// CL-6149: a folded run's pinned tool packages (`toolPackagePins`) carry
// no grants of their own — the deploy-time capability walk
// (`vendor/intx/workflow-deploy/src/capability-walk.ts`) only derives
// `tool:` grants for inline tool factories, so a pinned package's tools
// failed every call closed with "No matching grants". This builds the
// `ToolGrantsForPins` port every `FoldedRunsDeps` in this composition is
// wired with: given a launch's pins, look up each pin's package by name
// in the hub's own `describeCorbitsToolPackages()` read and mint one
// `tool:<qualifiedId>` / `invoke` declaration per tool, floored at `ask`
// for a tool the package itself marks `approval: "ask"`.
//
// Two planes live here, and the distinction is load-bearing. Those
// declarations are the wire frame the spawned child reads to decide whether
// a tool may be invoked at all. `createHubGrantRequirementsForPins` below is
// the other plane: what the HUB will honour once a tool calls back into one
// of its own guarded routes. Hub requirements never travel on the wire —
// they are resolved against the invoker's own authority and written as real
// `grant` rows at launch (`./run-hub-grants.ts`), so a pinned package can
// never mint itself an arbitrary resource/action pair.
import { MEMORY_GRANT_REQUIREMENTS } from "@corbits/memory";
import type { GrantEffect } from "@intx/types";
import type { ToolPackagePin } from "@intx/types/tool-packages";
import type {
  PinnedToolGrantDeclaration,
  ToolGrantsForPins,
} from "@corbits/folded-runs";
import type { CorbitsToolPackageDescription } from "@corbits/tool-registry-publish";

export function createToolGrantsForPins(
  descriptions: readonly CorbitsToolPackageDescription[],
): ToolGrantsForPins {
  const toolsByPackageName = new Map(
    descriptions.map((description) => [description.name, description.tools]),
  );
  return (pins) => {
    const grants: PinnedToolGrantDeclaration[] = [];
    for (const pin of pins) {
      const tools = toolsByPackageName.get(pin.name);
      if (tools === undefined) continue;
      for (const tool of tools) {
        grants.push({
          resource: `tool:${tool.qualifiedId}`,
          action: "invoke",
          effect: tool.approval === "ask" ? "ask" : "allow",
        });
      }
    }
    return grants;
  };
}

/** One authority a pinned package needs against the hub's own routes. */
export type HubGrantRequirement = {
  readonly resource: string;
  readonly action: string;
  readonly effect: GrantEffect;
};

export type HubGrantRequirementsForPins = (
  pins: readonly ToolPackagePin[],
) => readonly HubGrantRequirement[];

// `@corbits/memory-tools` reaches `@corbits/memory`'s own
// `registerMemoryRoutes` (see `./memory-mount.ts`), which gates every route
// behind `requireGrant("memory", action)` — a check the deleted
// `@corbits/memory-hub` surface never performed. The actions come from
// upstream's own declaration filtered to the `tools` surface, so a run never
// picks up the routes-only `forget`/`purge` authority just because it pinned
// the tools, and this list cannot drift from what the routes check.
// `memory_list` reads through the plane's own `search` action, so there is
// no separate `memory:list` requirement to declare.
const MEMORY_TOOLS_PACKAGE_NAME = "@corbits/memory-tools";
const MEMORY_TOOL_REQUIREMENTS: readonly HubGrantRequirement[] =
  MEMORY_GRANT_REQUIREMENTS.filter((requirement) =>
    (requirement.surfaces as readonly string[]).includes("tools"),
  ).map((requirement) => ({
    resource: requirement.resource,
    action: requirement.action,
    effect: "allow" as GrantEffect,
  }));

const HUB_REQUIREMENTS_BY_PACKAGE_NAME: ReadonlyMap<
  string,
  readonly HubGrantRequirement[]
> = new Map([[MEMORY_TOOLS_PACKAGE_NAME, MEMORY_TOOL_REQUIREMENTS]]);

export function createHubGrantRequirementsForPins(): HubGrantRequirementsForPins {
  return (pins) => {
    // Deduped by resource/action: a body may legitimately list the same
    // package more than once, and each duplicate would otherwise ask the
    // launch for another copy of the same grant row.
    const seen = new Set<string>();
    const requirements: HubGrantRequirement[] = [];
    for (const pin of pins) {
      const declared = HUB_REQUIREMENTS_BY_PACKAGE_NAME.get(pin.name);
      if (declared === undefined) continue;
      for (const requirement of declared) {
        const key = `${requirement.resource}:${requirement.action}`;
        if (seen.has(key)) continue;
        seen.add(key);
        requirements.push(requirement);
      }
    }
    return requirements;
  };
}
