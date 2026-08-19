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
import type {
  PinnedToolGrantDeclaration,
  ToolGrantsForPins,
} from "@corbits/folded-runs";
import type { CorbitsToolPackageDescription } from "@corbits/tool-registry-publish";

// CL-6296: pinning `@corbits/memory-tools` reaches `@corbits/memory`'s
// own `registerMemoryRoutes` now (see `./memory-mount.ts`), which gates
// every route behind `requireGrant("memory", action)` — a check the old
// `@corbits/memory-hub` surface never performed, so nothing has ever
// minted these before. A run's synthetic principal otherwise carries only
// the `tool:<qualifiedId>` grants above, never a tenant-owner's wildcard,
// so without this every workflow memory call would 403 the instant it
// reached the plane. `memory_list` reads through the plane's own `search`
// action (see `@corbits/memory`'s `mountListRoute`), so no separate
// `memory:list` grant exists to mint.
const MEMORY_TOOLS_PACKAGE_NAME = "@corbits/memory-tools";
const MEMORY_RESOURCE_GRANTS: readonly PinnedToolGrantDeclaration[] = [
  { resource: "memory", action: "add", effect: "allow" },
  { resource: "memory", action: "search", effect: "allow" },
];

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
      if (pin.name === MEMORY_TOOLS_PACKAGE_NAME) {
        grants.push(...MEMORY_RESOURCE_GRANTS);
      }
    }
    return grants;
  };
}
