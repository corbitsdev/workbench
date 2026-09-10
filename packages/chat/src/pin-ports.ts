// Ports the hub composition root supplies so a provisioned agent's
// pinned tool packages get grants and credential bindings Interchange
// cannot derive from the definition alone.
import type { CredentialBinding, GrantEffect } from "@intx/types";
import type { ToolPackagePin } from "@intx/types/tool-packages";

export type PinnedToolGrantDeclaration = {
  readonly resource: string;
  readonly action: "invoke";
  readonly effect: GrantEffect;
};

export type ToolGrantsForPins = (
  tenantId: string,
  pins: readonly ToolPackagePin[],
) => Promise<readonly PinnedToolGrantDeclaration[]>;

export type McpCredentialBindingsFor = (
  tenantId: string,
) => Promise<readonly CredentialBinding[]>;

export type PinnedPackageCredentialBindingsFor = (
  tenantId: string,
  pins: readonly ToolPackagePin[],
) => Promise<readonly CredentialBinding[]>;
