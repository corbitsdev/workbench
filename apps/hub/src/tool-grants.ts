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
