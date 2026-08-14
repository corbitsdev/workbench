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
  /**
   * Which credential-provider plugin mediates this connector's secret at
   * run time — the sidecar registers `"http"` (Bearer), `"http-raw-authorization"`
   * (raw `authorization` header, e.g. Linear), and `"http-x-api-key"`
   * (`x-api-key` header, e.g. Exa, ScrapeCreators). Provider rows are
   * seeded with this key; an unknown key means no mediated fetch resolves
   * at capability time.
   */
  readonly credentialPlugin: "http" | "http-raw-authorization" | "http-x-api-key";
  /** Tool packages this connector's credential feeds — the settings card's
   * "Pinned by" line. Empty for inference-provider connectors, which feed
   * workflow deployments, not a specific tool package. */
  readonly feedsTools: readonly string[];
  /** api-key connectors only. Absent for oauth-pkce/oauth-code/webhook-secret
   * descriptors (Track A ships those as display-only entries; wiring their
   * flows is a later ticket). */
  readonly probe?: (apiKey: string) => Promise<CredentialTestResult>;
}
