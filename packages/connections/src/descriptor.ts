// The shape every entry in the connector registry (`./registry.ts`)
// implements: enough for the settings-ui Connections surface to render
// a card and, for an api-key connector, drive the test-then-store flow
// `./routes.ts` exposes. OAuth connectors (`oauth-pkce`/`oauth-code`)
// are display-only entries for Track A — wiring their flows through
// this registry is a later ticket, so they carry no `probe`.
import type { CredentialTestResult } from "@workbench/hub-client/credential-test";

export type ConnectorAuthKind =
  "oauth-pkce" | "oauth-code" | "api-key" | "webhook-secret";

export interface ConnectorDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly authKind: ConnectorAuthKind;
  readonly docsUrl: string;
  /** Tool packages this connector's credential feeds — the settings card's
   * "Pinned by" line. Empty for inference-provider connectors, which feed
   * workflow deployments, not a specific tool package. */
  readonly feedsTools: readonly string[];
  /** api-key connectors only. Absent for oauth-pkce/oauth-code/webhook-secret
   * descriptors (Track A ships those as display-only entries; wiring their
   * flows is a later ticket). */
  readonly probe?: (apiKey: string) => Promise<CredentialTestResult>;
}
