// The browser-safe half of the Connections surface: the connector
// descriptor shape and the generic helpers a caller needs to work with a
// registry built from it. This package no longer bakes in any concrete
// connector set — CL-7384 moved every actual descriptor (GitHub, Gmail,
// Hugging Face, OpenRouter, the inference providers, ...) out to
// `templates/connectors.ts`, the product-data package a build supplies.
// A caller builds its own registry with `createConnectorRegistry` and
// passes it into every route factory that needs one — never a default
// baked in here, which would be exactly the fallback this package's
// callers are told never to leave lying around.
export {
  missingCredentialDetail,
  parseMissingCredentialDetail,
  type MissingCredentialDetail,
} from "./missing-credential-detail";
export type {
  ConnectorAuthKind,
  ConnectorDescriptor,
  ConnectorOAuthConfig,
  OAuthExchangeResult,
} from "./descriptor";
import type { ConnectorDescriptor } from "./descriptor";

export type ConnectorRegistry = Readonly<Record<string, ConnectorDescriptor>>;

/** Identity function with a name — lets a caller building its own
 * connector set (e.g. `templates/connectors.ts`) get `ConnectorRegistry`'s
 * type checking on the literal without importing the type by hand. */
export function createConnectorRegistry(
  connectors: Readonly<Record<string, ConnectorDescriptor>>,
): ConnectorRegistry {
  return connectors;
}

export function connectorDescriptors(
  registry: ConnectorRegistry,
): readonly ConnectorDescriptor[] {
  return Object.values(registry);
}
