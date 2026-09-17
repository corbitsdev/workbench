// The composition root's own port for a provisioned agent's pinned tool
// packages: a tenant binding only when a pin names a package a
// `CONNECTOR_REGISTRY` entry `feedsTools` AND the tenant already has a
// connected credential for that connector (`isConnectorConnected`, the
// same owning check `createWorkflowConnectionRoutes` uses). Static-handle
// packages (`@corbits/manus-tools`, granola-tools, …) declare
// `interchange.credentials`, but requiring those binds unconditionally
// would throw `MissingCredentialError` on signup / first launch.
//
// `PinnedPackageCredentialBindingsFor`'s shape is declared locally rather
// than imported: it names nothing chat-specific (`CredentialBinding`,
// `ToolPackagePin` are both native `@intx/types`), so the hub owns its own
// copy of the port instead of depending on `@corbits/chat` for it.
import type { CredentialBinding } from "@intx/types";
import type { ToolPackagePin } from "@intx/types/tool-packages";
import { CONNECTOR_REGISTRY } from "./native-connector-registry";

export type PinnedPackageCredentialBindingsFor = (
  tenantId: string,
  pins: readonly ToolPackagePin[],
) => Promise<readonly CredentialBinding[]>;

export type IsConnectorConnected = (tenantId: string, connectorId: string) => Promise<boolean>;

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
