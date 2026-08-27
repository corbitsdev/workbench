// The `PinnedPackageCredentialBindingsFor` port every `FoldedRunsDeps`
// below is wired with — see `@corbits/folded-runs`' `types.ts` for why
// this has to be supplied by the composition root rather than declared as
// a required assistant `credentialBindings` entry. Static-handle packages
// (`@corbits/manus-tools`, granola-tools, …) declare
// `interchange.credentials`, but requiring those binds on the assistant
// would throw `MissingCredentialError` on signup / first chat. This
// factory emits a tenant binding only when a pin names a package a
// `CONNECTOR_REGISTRY` entry `feedsTools` AND the tenant already has a
// connected credential for that connector (`isConnectorConnected`, the
// same owning check `createWorkflowConnectionRoutes` uses — not
// `@corbits/chat`'s catalog-only `listConnectedProviders`).
import type { CredentialBinding } from "@intx/types";
import type { ToolPackagePin } from "@intx/types/tool-packages";
import type { PinnedPackageCredentialBindingsFor } from "@corbits/folded-runs";
import { CONNECTOR_REGISTRY } from "@workbench/connections/registry";

export type IsConnectorConnected = (
  tenantId: string,
  connectorId: string,
) => Promise<boolean>;

export function bindingsForConnectedPins(
  pins: readonly ToolPackagePin[],
  connectedConnectorIds: readonly string[],
): readonly CredentialBinding[] {
  const pinNames = new Set(pins.map((pin) => pin.name));
  if (pinNames.size === 0) return [];
  const connected = new Set(connectedConnectorIds);
  const bindings: CredentialBinding[] = [];
  for (const descriptor of Object.values(CONNECTOR_REGISTRY)) {
    if (!connected.has(descriptor.id)) continue;
    for (const toolPackageName of descriptor.feedsTools) {
      if (!pinNames.has(toolPackageName)) continue;
      bindings.push({
        package: toolPackageName,
        handle: descriptor.id,
        provider: descriptor.id,
        locator: "tenant",
      });
    }
  }
  return bindings;
}

export function createPinnedPackageCredentialBindingsFor(
  isConnectorConnected: IsConnectorConnected,
): PinnedPackageCredentialBindingsFor {
  return async (tenantId, pins) => {
    const pinNames = new Set(pins.map((pin) => pin.name));
    if (pinNames.size === 0) return [];
    const connectedConnectorIds: string[] = [];
    for (const descriptor of Object.values(CONNECTOR_REGISTRY)) {
      if (!descriptor.feedsTools.some((name) => pinNames.has(name))) continue;
      if (await isConnectorConnected(tenantId, descriptor.id)) {
        connectedConnectorIds.push(descriptor.id);
      }
    }
    return bindingsForConnectedPins(pins, connectedConnectorIds);
  };
}
