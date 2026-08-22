// The guided-capability-add fail-closed check: an addition to a
// definition's tools/skills/model is only ever accepted if it names
// something the tenant's live inventory actually offers. This mirrors
// this codebase's other inventory-validation ports (parse the
// addition, then check its one reference against a `Set` built from the
// inventory that was actually offered) exactly — but the caller
// deploys through this package's own builder, so importing its
// inventory type back here would cycle. `CapabilityInventory` below is
// the same shape stripped to what a single addition needs to check
// against; the composition root (`apps/hub`) wires it from the exact
// same listers the drafting inventory uses, so the two inventories one
// tenant sees are never allowed to drift apart even though the types
// are declared twice.
import { type } from "arktype";

export type CapabilityToolPackageEntry = { readonly name: string };
export type CapabilitySkillEntry = { readonly name: string };
export type CapabilityModelEntry = { readonly canonicalName: string };

/**
 * The pins every created specialist carries unless the caller names its
 * own: search (via the workbench's MCP connections), firm memory, and
 * the ask_user interaction card. A specialist without these is a name
 * with a prompt — a "research agent" that cannot search (CL-6206).
 */
export const BASELINE_AGENT_TOOL_PINS = [
  "@corbits/mcp-tools",
  "@corbits/memory-tools",
  "@corbits/interaction-tools",
] as const;

/** The baseline pins this tenant can actually resolve — a package the
 * registry does not carry is dropped, never pinned to fail at launch. */
export function baselineAgentToolPins(
  inventory: CapabilityInventory,
): string[] {
  const available = new Set(inventory.toolPackages.map((entry) => entry.name));
  return BASELINE_AGENT_TOOL_PINS.filter((name) => available.has(name));
}

export type CapabilityInventory = {
  readonly toolPackages: readonly CapabilityToolPackageEntry[];
  readonly skills: readonly CapabilitySkillEntry[];
  readonly models: readonly CapabilityModelEntry[];
};

export type CapabilityInventoryProvider = {
  resolve(caller: {
    readonly tenantId: string;
    readonly principalId: string;
  }): Promise<CapabilityInventory>;
};

export class CapabilityOutOfInventoryError extends Error {
  constructor(field: string, reference: string) {
    super(
      `"${reference}" for "${field}" was never offered in this workbench's inventory`,
    );
    this.name = "CapabilityOutOfInventoryError";
  }
}

export const AddCapabilityInput = type({
  kind: "'toolPackage'",
  name: "string > 0",
})
  .or(type({ kind: "'skill'", name: "string > 0" }))
  .or(type({ kind: "'model'", canonicalName: "string > 0" }));
export type AddCapabilityInput = typeof AddCapabilityInput.infer;

/**
 * Asserts `addition` names something `inventory` actually offers. Throws
 * `CapabilityOutOfInventoryError` on the first (only) violation — never
 * partially trusted, exactly like the other inventory checks this mirrors.
 */
export function assertCapabilityInInventory(
  addition: AddCapabilityInput,
  inventory: CapabilityInventory,
): void {
  switch (addition.kind) {
    case "toolPackage": {
      const known = inventory.toolPackages.some(
        (entry) => entry.name === addition.name,
      );
      if (!known) {
        throw new CapabilityOutOfInventoryError("toolPackage", addition.name);
      }
      return;
    }
    case "skill": {
      const known = inventory.skills.some(
        (entry) => entry.name === addition.name,
      );
      if (!known) {
        throw new CapabilityOutOfInventoryError("skill", addition.name);
      }
      return;
    }
    case "model": {
      const known = inventory.models.some(
        (entry) => entry.canonicalName === addition.canonicalName,
      );
      if (!known) {
        throw new CapabilityOutOfInventoryError(
          "model",
          addition.canonicalName,
        );
      }
      return;
    }
  }
}
