// The one persist-and-seed sequence every connect surface runs once a
// secret is proven (by probe or by OAuth exchange): ensureProvider →
// ensureCredential → seedCatalog-if-inference. Before CL-6394 this
// sequence existed as three parallel copies (`routes.ts`'s
// `/:connectorId/complete`, `oauth-tenant-connect.ts`, and
// `@workbench/onboarding`'s `testAndPersistCredential`) and their
// divergence is exactly what let a GitHub callback fall into an
// inference-only `seedCatalog` — a non-inference connector must never
// reach `CATALOG_SEEDS`, and here that rule lives in one place.
//
// The provider row is named by the connector's lowercase `id` (the
// canonical name `credentialBindings` resolve against); the credential
// row carries the human-facing `displayName` — the exact name the
// Plugins gallery's resolver looks up. `seedCatalog` is passed that same
// `credentialName` so its own internal `ensureCredential` resolves to
// the row planted here rather than a second `<provider>-default` row.
import {
  PROVIDER_TEST_CONFIG,
  type SupportedCredentialProvider,
} from "@workbench/hub-client";
import {
  ensureCredential,
  ensureProvider,
  seedCatalog,
  type EnsureCredentialArgs,
  type EnsureProviderArgs,
  type SeedCatalogArgs,
} from "@corbits/seeding";
import type { ApiCall } from "@corbits/hub-api-client";
import type { ConnectorDescriptor } from "./descriptor";

export function isInferenceProvider(
  id: string,
): id is SupportedCredentialProvider {
  return Object.hasOwn(PROVIDER_TEST_CONFIG, id);
}

/** The test seams every route factory in this package already exposes,
 * shared verbatim so a caller can thread its own overrides through. */
export type PersistConnectorCredentialFns = {
  readonly ensureProviderFn?: (
    api: ApiCall,
    cookies: string[],
    args: EnsureProviderArgs,
    log: (line: string) => void,
  ) => ReturnType<typeof ensureProvider>;
  readonly ensureCredentialFn?: (
    api: ApiCall,
    cookies: string[],
    args: EnsureCredentialArgs,
    log: (line: string) => void,
  ) => ReturnType<typeof ensureCredential>;
  readonly seedCatalogFn?: (
    args: SeedCatalogArgs,
  ) => ReturnType<typeof seedCatalog>;
};

export type PersistConnectorCredentialArgs = PersistConnectorCredentialFns & {
  readonly api: ApiCall;
  readonly cookies: string[];
  readonly tenantId: string;
  readonly descriptor: ConnectorDescriptor;
  /** The credential secret to store: a probed pasted key, an
   * OAuth-exchanged token, or — for a url-kind connector (Ollama) — the
   * fixed placeholder secret, with the instance URL in
   * `baseURLOverride`. Always already proven by the caller, so the row
   * is stored `verified: true`. */
  readonly secret: string;
  /** Free-form data stored on the credential's `metadata` field — the
   * extension point an expiring OAuth token's expiry lives in. Its
   * presence is also what types the row `oauth_token` instead of
   * `api_key`. */
  readonly credentialMetadata?: Record<string, unknown>;
  /** A provider-issued refresh token — stored on the credential row's
   * own `refreshSecret` field (a secret, never metadata). Only ever set
   * alongside `credentialMetadata`'s `expiresAt`. */
  readonly refreshSecret?: string;
  /** The instance origin a url-kind connector actually points at —
   * stored as the provider row's `apiBaseUrl` and threaded into
   * `seedCatalog`'s own base-URL seam. */
  readonly baseURLOverride?: string;
  readonly log: (line: string) => void;
};

export async function persistConnectorCredential(
  args: PersistConnectorCredentialArgs,
): Promise<{
  credentialId: string;
  /** The catalog seed's own report (CL-6351's model-capability read
   * included) — absent for a non-inference connector, which never
   * seeds a catalog. */
  seedResult?: Awaited<ReturnType<typeof seedCatalog>>;
}> {
  const runEnsureProvider = args.ensureProviderFn ?? ensureProvider;
  const runEnsureCredential = args.ensureCredentialFn ?? ensureCredential;
  const runSeedCatalog = args.seedCatalogFn ?? seedCatalog;
  const credentialType =
    args.credentialMetadata !== undefined
      ? ("oauth_token" as const)
      : ("api_key" as const);

  const providerArgs: EnsureProviderArgs =
    args.baseURLOverride !== undefined
      ? {
          tenantId: args.tenantId,
          name: args.descriptor.id,
          plugin: args.descriptor.credentialPlugin,
          apiBaseUrl: args.baseURLOverride,
        }
      : args.descriptor.id === "manus"
        ? {
            tenantId: args.tenantId,
            name: args.descriptor.id,
            plugin: args.descriptor.credentialPlugin,
            apiBaseUrl: "https://api.manus.ai",
          }
        : {
            tenantId: args.tenantId,
            name: args.descriptor.id,
            plugin: args.descriptor.credentialPlugin,
          };
  const providerId = await runEnsureProvider(
    args.api,
    args.cookies,
    providerArgs,
    args.log,
  );

  const credentialArgs: EnsureCredentialArgs =
    args.credentialMetadata !== undefined
      ? {
          tenantId: args.tenantId,
          providerId,
          name: args.descriptor.displayName,
          secret: args.secret,
          type: credentialType,
          verified: true,
          metadata: args.credentialMetadata,
          ...(args.refreshSecret !== undefined
            ? { refreshSecret: args.refreshSecret }
            : {}),
        }
      : {
          tenantId: args.tenantId,
          providerId,
          name: args.descriptor.displayName,
          secret: args.secret,
          type: credentialType,
          verified: true,
        };
  const credentialId = await runEnsureCredential(
    args.api,
    args.cookies,
    credentialArgs,
    args.log,
  );

  // An inference provider connected anywhere must become usable, not
  // just stored: plant its curated model catalog so the models show up
  // in Inference and a workbench can actually run on them. A
  // non-inference connector (GitHub, Linear, ...) has no catalog seed
  // and must never reach `CATALOG_SEEDS`.
  if (isInferenceProvider(args.descriptor.id)) {
    const seedArgs: SeedCatalogArgs = {
      api: args.api,
      cookies: args.cookies,
      tenantId: args.tenantId,
      log: args.log,
      provider: args.descriptor.id,
      apiKey: args.secret,
      credentialName: args.descriptor.displayName,
      credentialType,
      credentialVerified: true,
      // The row planted above is the one and only credential write —
      // seedCatalog plants the catalog side against it instead of
      // ensuring (and re-rotating) a row of its own.
      existingCredentialId: credentialId,
    };
    if (args.credentialMetadata !== undefined) {
      seedArgs.credentialMetadata = args.credentialMetadata;
    }
    if (args.baseURLOverride !== undefined) {
      seedArgs.baseURLOverride = args.baseURLOverride;
    }
    const seedResult = await runSeedCatalog(seedArgs);
    return { credentialId, seedResult };
  }

  return { credentialId };
}
