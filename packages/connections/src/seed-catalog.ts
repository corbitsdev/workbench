// Credential + catalog planting over the hub HTTP API — idempotent
// ensure-by-name helpers (`ensureProvider`, `ensureCredential`,
// `ensureCatalogModel/Provider/Offering`) and the curated-catalog planter
// (`seedCatalog`, driven by `./catalog-seed-data.ts`).
//
// Relocated here by CL-7585: this is the credential domain's own connect-time planting,
// not bench seeding, so it lives with the connect flows that call it
// (`persist-credential.ts`, `routes.ts`, `mcp-oauth-routes.ts`,
// `mcp-server-routes.ts`). The tenant-scale `seedTenant` deploy flow
// did not move — native setup owns 0→1 now.

import {
  Capability,
  CredentialResponse,
  ModelOfferingResponse,
  ModelProviderResponse,
  ModelResponse,
  ProviderResponse,
  paginatedSchema,
} from "@intx/types";
import { type } from "arktype";
import { HubApiError, parseAs, type ApiCall } from "@corbits/hub-api-client";
import { capabilitiesForDeployment } from "@corbits/inference-catalog/offering-capabilities";
import { quirksForDeployment } from "@corbits/inference-catalog/ollama-context-defaults";
import { CATALOG_SEEDS, type CatalogModelSpec } from "./catalog-seed-data";
import {
  fetchOllamaModelCatalog,
  ollamaOpenAICompatBaseURL,
  type SupportedCredentialProvider,
} from "@corbits/connections/credential-test";
import { hasCompletionCapableModel } from "@corbits/connections/model-capability";

// The credential name a seeded inference source stores its secret
// under; distinct from the provider name so re-runs and manual
// inspection are never ambiguous about which is which. Exported so a
// caller that needs to find that same row later (e.g. checking whether
// a just-connected provider's credential already exists) names it the
// same way `seedCatalog` did, rather than re-deriving the convention.
export function inferenceCredentialName(providerName: string): string {
  return `${providerName}-default`;
}

export type EnsureProviderArgs = {
  tenantId: string;
  name: string;
  plugin: string;
  /** The API origin an `http`-plugin credential from this provider pins
   * its requests to (`CreateProvider`'s own field, `@intx/types`).
   * Every fixed connector today (GitHub, Exa, ...) lets the hub-side
   * plugin default this; a dynamic-origin connector — a tenant-supplied
   * MCP server URL — must set it explicitly, or credential resolution
   * fails closed with `no_origin`. */
  apiBaseUrl?: string;
};

export async function ensureProvider(
  api: ApiCall,
  cookies: string[],
  args: EnsureProviderArgs,
  log: (line: string) => void,
): Promise<string> {
  const created = await api(
    "POST",
    `/api/tenants/${args.tenantId}/providers`,
    { name: args.name, plugin: args.plugin, apiBaseUrl: args.apiBaseUrl },
    cookies,
  );
  if (created.status === 201) {
    const provider = parseAs(ProviderResponse, created.data, "provider response");
    log(`created provider ${args.name}`);
    return provider.id;
  }
  if (created.status !== 409) {
    throw new HubApiError(
      `the hub rejected creation of provider ${args.name} with status ${created.status}: ${JSON.stringify(created.data)}`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }

  const listed = await api(
    "GET",
    `/api/tenants/${args.tenantId}/providers?inherited=false`,
    undefined,
    cookies,
  );
  const providers = parseAs(
    paginatedSchema(ProviderResponse),
    listed.data,
    "providers response",
  ).data;
  const existing = providers.find((p) => p.name === args.name);
  if (!existing) {
    throw new HubApiError(
      `provider ${args.name} reported a name conflict but is not listable on the bench`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }
  if (args.apiBaseUrl !== undefined && existing.apiBaseUrl == null) {
    const updated = await api(
      "PATCH",
      `/api/tenants/${args.tenantId}/providers/${existing.id}`,
      { apiBaseUrl: args.apiBaseUrl },
      cookies,
    );
    if (updated.status !== 200) {
      throw new HubApiError(
        `the hub rejected the API origin for provider ${args.name} with status ${updated.status}`,
        "check the provider configuration before retrying setup",
      );
    }
    parseAs(ProviderResponse, updated.data, "provider response");
    log(`set API origin for provider ${args.name}`);
  }
  log(`provider ${args.name} already exists (skipped)`);
  return existing.id;
}

export type EnsureCredentialArgs = {
  tenantId: string;
  providerId: string;
  name: string;
  secret: string;
  type: "api_key" | "oauth_token";
  /** An `oauth_token` credential from a provider whose grant issues a
   * refresh token — absent for a provider that never does (Hugging
   * Face's PKCE flow), never a coerced empty string. */
  refreshSecret?: string;
  /** ISO instant the access token expires, when the provider reports one. */
  expiresAt?: string;
  metadata?: Record<string, unknown>;
  /**
   * Set by a caller that received `secret` as an explicit user
   * submission through a connect UI (a pasted key, a completed OAuth
   * exchange) before reaching `ensureCredential` — never inferred here,
   * and never conditioned on a probe (CL-6123 dropped the onboarding
   * probe that used to gate this). Gates whether an `api_key` name
   * conflict rotates the stored secret (see the 409 branch below); an
   * `oauth_token` conflict decides rotation from the stored row's
   * `status` instead and ignores this flag. Left unset by a plain
   * `workbench seed` or the hub-owned env auto-plant (CL-6101's
   * `plantEnvProviderCredentials`, which keeps its own boot-time probe
   * but never sets this — its rule is never-overwrite, not rotate), so
   * a routine re-seed with an unchanged key still just skips.
   */
  verified?: boolean;
};

export async function ensureCredential(
  api: ApiCall,
  cookies: string[],
  args: EnsureCredentialArgs,
  log: (line: string) => void,
): Promise<string> {
  const created = await api(
    "POST",
    `/api/tenants/${args.tenantId}/credentials`,
    {
      providerId: args.providerId,
      name: args.name,
      type: args.type,
      secret: args.secret,
      refreshSecret: args.refreshSecret,
      expiresAt: args.expiresAt,
      metadata: args.metadata,
    },
    cookies,
  );
  if (created.status === 201) {
    const credential = parseAs(CredentialResponse, created.data, "credential response");
    log(`created credential ${args.name}`);
    return credential.id;
  }
  if (created.status !== 409) {
    throw new HubApiError(
      `the hub rejected creation of credential ${args.name} with status ${created.status}: ${JSON.stringify(created.data)}`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }

  const listed = await api("GET", `/api/tenants/${args.tenantId}/credentials`, undefined, cookies);
  const credentials = parseAs(
    paginatedSchema(CredentialResponse),
    listed.data,
    "credentials response",
  ).data;
  const existing = credentials.find((c) => c.name === args.name);
  if (!existing) {
    throw new HubApiError(
      `credential ${args.name} reported a name conflict but is not listable on the bench`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }

  // An `oauth_token` credential (Hugging Face, or an MCP server connected
  // through OAuth) rotates on a name conflict in two distinct cases:
  //
  // 1. The stored row has gone stale (`status !== "active"`) — a plain
  //    re-seed or a reconnect after the expiry sweep already flipped it.
  //    Reusing the stale row instead of rotating it would silently strand
  //    the reconnect on the old, already-expired secret, and since the
  //    row's `status` is already non-`active`, the expiry sweep would
  //    never see it again to re-notify.
  // 2. The caller sets `args.verified` — an interactive OAuth reconnect
  //    (`connections`' `mcp-oauth-routes.ts`) completed a fresh exchange
  //    and is handing `ensureCredential` a genuinely new token, even
  //    though the existing row hasn't technically expired yet (the user
  //    re-authorized proactively, or the provider-side scopes changed).
  //    Gating on `status` alone silently dropped this token (CL-7236):
  //    zero PATCH call, and the stale row's id returned as if the
  //    reconnect had worked.
  //
  // A plain `workbench seed` never sets `verified` on an `oauth_token`
  // credential — its token comes straight from env with no OAuth exchange
  // of its own — so an idempotent re-seed of a still-active row still
  // just skips, exactly as before.
  //
  // An `api_key` credential (OpenRouter, an onboarding-picked provider)
  // has no staleness signal at all — its row stays `active` whether or
  // not the person reconnecting regenerated the key or is retrying after
  // a bad paste — so it rotates on a name conflict only when
  // `args.verified` is set, which a caller sets only for an explicit user
  // submission through a connect UI: `connections`'
  // `POST /:connectorId/complete` (`routes.ts`) sets it only after
  // `descriptor.probe` passes, since that surface (Settings > Connections)
  // is allowed to block on a real check.
  const shouldRotate =
    args.type === "oauth_token"
      ? existing.status !== "active" || args.verified === true
      : args.verified === true;
  if (shouldRotate) {
    const rotated = await api(
      "PATCH",
      `/api/tenants/${args.tenantId}/credentials/${existing.id}`,
      {
        secret: args.secret,
        refreshSecret: args.refreshSecret,
        expiresAt: args.expiresAt,
        status: "active",
        metadata: args.metadata,
      },
      cookies,
    );
    if (rotated.status !== 200) {
      throw new HubApiError(
        `the hub rejected rotating credential ${args.name} with status ${rotated.status}: ${JSON.stringify(rotated.data)}`,
        "check the hub logs for the underlying failure, then re-run: workbench seed",
      );
    }
    const credential = parseAs(CredentialResponse, rotated.data, "credential response");
    log(`rotated credential ${args.name} (reconnect refreshed the stored secret)`);
    return credential.id;
  }

  log(`credential ${args.name} already exists (skipped; its secret is not updated by seeding)`);
  return existing.id;
}

export async function ensureCatalogModel(
  api: ApiCall,
  cookies: string[],
  args: { tenantId: string; canonicalName: string },
  log: (line: string) => void,
): Promise<string> {
  const created = await api(
    "POST",
    `/api/tenants/${args.tenantId}/catalog/models`,
    { canonicalName: args.canonicalName },
    cookies,
  );
  if (created.status === 201) {
    const model = parseAs(ModelResponse, created.data, "catalog model response");
    log(`created catalog model ${args.canonicalName}`);
    return model.id;
  }
  if (created.status !== 409) {
    throw new HubApiError(
      `the hub rejected creation of catalog model ${args.canonicalName} with status ${created.status}: ${JSON.stringify(created.data)}`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }

  const listed = await api(
    "GET",
    `/api/tenants/${args.tenantId}/catalog/models`,
    undefined,
    cookies,
  );
  const models = parseAs(
    paginatedSchema(ModelResponse),
    listed.data,
    "catalog models response",
  ).data;
  const existing = models.find((m) => m.canonicalName === args.canonicalName);
  if (!existing) {
    throw new HubApiError(
      `catalog model ${args.canonicalName} reported a name conflict but is not listable on the bench`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }
  log(`catalog model ${args.canonicalName} already exists (skipped)`);
  return existing.id;
}

export async function ensureCatalogProvider(
  api: ApiCall,
  cookies: string[],
  args: {
    tenantId: string;
    name: string;
    plugin: string;
    baseURL: string;
    credentialId: string;
  },
  log: (line: string) => void,
): Promise<string> {
  const created = await api(
    "POST",
    `/api/tenants/${args.tenantId}/catalog/providers`,
    {
      name: args.name,
      plugin: args.plugin,
      baseURL: args.baseURL,
      credentialId: args.credentialId,
    },
    cookies,
  );
  if (created.status === 201) {
    const provider = parseAs(ModelProviderResponse, created.data, "catalog provider response");
    log(`created catalog provider ${args.name}`);
    return provider.id;
  }
  if (created.status !== 409) {
    throw new HubApiError(
      `the hub rejected creation of catalog provider ${args.name} with status ${created.status}: ${JSON.stringify(created.data)}`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }

  const listed = await api(
    "GET",
    `/api/tenants/${args.tenantId}/catalog/providers`,
    undefined,
    cookies,
  );
  const providers = parseAs(
    paginatedSchema(ModelProviderResponse),
    listed.data,
    "catalog providers response",
  ).data;
  const existing = providers.find((p) => p.name === args.name);
  if (!existing) {
    throw new HubApiError(
      `catalog provider ${args.name} reported a name conflict but is not listable on the bench`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }
  log(`catalog provider ${args.name} already exists (skipped)`);
  return existing.id;
}

export async function ensureCatalogOffering(
  api: ApiCall,
  cookies: string[],
  args: {
    tenantId: string;
    modelId: string;
    providerId: string;
    priority: number;
    capabilities: readonly Capability[];
    quirks?: Record<string, unknown>;
  },
  log: (line: string) => void,
): Promise<string> {
  const body: Record<string, unknown> = {
    modelId: args.modelId,
    providerId: args.providerId,
    priority: args.priority,
    capabilities: args.capabilities,
  };
  if (args.quirks !== undefined) body["quirks"] = args.quirks;
  const created = await api(
    "POST",
    `/api/tenants/${args.tenantId}/catalog/offerings`,
    body,
    cookies,
  );
  if (created.status === 201) {
    const offering = parseAs(ModelOfferingResponse, created.data, "catalog offering response");
    log("created catalog offering");
    return offering.id;
  }
  if (created.status === 409) {
    let cursor: string | null = null;
    let existing: typeof ModelOfferingResponse.infer | undefined;
    do {
      const listed = await api(
        "GET",
        `/api/tenants/${args.tenantId}/catalog/offerings${cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`}`,
        undefined,
        cookies,
      );
      const page = parseAs(
        paginatedSchema(ModelOfferingResponse),
        listed.data,
        "catalog offerings response",
      );
      existing = page.data.find(
        (offering) => offering.modelId === args.modelId && offering.providerId === args.providerId,
      );
      cursor = page.nextCursor;
    } while (existing === undefined && cursor !== null);
    if (!existing) {
      throw new HubApiError(
        "catalog offering reported a conflict but is not listable on the bench",
        "check the hub logs for the underlying failure, then re-run: workbench seed",
      );
    }
    if (existing.priority === args.priority) {
      log("catalog offering already exists (skipped)");
      return existing.id;
    }

    const updated = await api(
      "PATCH",
      `/api/tenants/${args.tenantId}/catalog/offerings/${existing.id}`,
      { priority: args.priority },
      cookies,
    );
    if (updated.status !== 200) {
      throw new HubApiError(
        `the hub rejected updating the catalog offering priority with status ${updated.status}: ${JSON.stringify(updated.data)}`,
        "check the hub logs for the underlying failure, then re-run: workbench seed",
      );
    }
    const offering = parseAs(ModelOfferingResponse, updated.data, "catalog offering response");
    log("updated catalog offering priority");
    return offering.id;
  }
  throw new HubApiError(
    `the hub rejected creation of the catalog offering with status ${created.status}: ${JSON.stringify(created.data)}`,
    "check the hub logs for the underlying failure, then re-run: workbench seed",
  );
}

// Named so it can never be mistaken for a real secret if it leaks into
// a log line, a screenshot, or a bug report.
export const PLACEHOLDER_CATALOG_API_KEY = "placeholder-not-a-real-key";

/**
 * Thrown by `seedCatalog` when a caller asks for a placeholder credential
 * against an OAuth-only provider — `codex` and `xai-oauth` have no API-key
 * path at all, so a fake `"placeholder-not-a-real-key"` secret could never
 * authenticate and would only make the offering look launchable when no
 * turn against it can ever succeed. A real token from the provider's own
 * OAuth login (or a seeded `apiKey`) is the only way to make these
 * launchable.
 */
export class PlaceholderCredentialError extends Error {
  override readonly name = "PlaceholderCredentialError";
}

/** Providers whose only credential is a real OAuth token —
 * `placeholderCredential: true` is a `PlaceholderCredentialError` for
 * these, never a planted fake. */
const OAUTH_ONLY_CATALOG_PROVIDERS: ReadonlySet<SupportedCredentialProvider> = new Set([
  "codex",
  "xai-oauth",
]);

export type SeedCatalogArgs = {
  api: ApiCall;
  cookies: string[];
  tenantId: string;
  log: (line: string) => void;
  /**
   * Which provider's curated catalog seed (`CATALOG_SEEDS`) to plant.
   * Defaults to `"anthropic"` — the operator-configured provider a plain
   * `workbench seed` plants — so every existing caller that seeds a
   * single hub-owned key keeps working unchanged. Onboarding's
   * self-served credential flow always passes the provider the person
   * actually connected.
   */
  provider?: SupportedCredentialProvider;
  /**
   * A real API key for `provider`. When set, `seedCatalog` plants a
   * credential row alongside the catalog data, making the seeded
   * offerings launchable.
   */
  apiKey?: string;
  /**
   * Explicit opt-in to plant a placeholder credential when `apiKey` is
   * not set, so a keyless dev or CI run can still launch workbench
   * anchors. Plain `workbench seed` never sets this — only callers that
   * need a launchable chain without a real key (the local dev
   * bootstrap, the e2e harness) pass it.
   */
  placeholderCredential?: boolean;
  /**
   * The credential type the seeded row is stored as. Defaults to
   * `"api_key"` for a pasted secret; a connect flow that mints an
   * expiring OAuth access token (Hugging Face) passes `"oauth_token"`
   * so the row is honestly typed.
   */
  credentialType?: "api_key" | "oauth_token";
  /**
   * Overrides the seeded credential row's name — defaults to
   * `inferenceCredentialName(seed.provider.name)`. A caller whose
   * credential must also resolve by name elsewhere (the Plugins
   * gallery's `GET .../credentials/resolve/:name`, which looks up a
   * connector's `descriptor.displayName`) passes that same name here,
   * so the one row satisfies both readers instead of leaving a
   * connect flow's credential invisible to a reader that expects the
   * other naming convention.
   */
  credentialName?: string;
  /**
   * Free-form data attached to the seeded credential's `metadata`
   * field — the extension point a token's expiry timestamp lives in,
   * never interpreted by this function.
   */
  credentialMetadata?: Record<string, unknown>;
  /**
   * Passed straight through to `ensureCredential`'s own `verified` — set
   * only by a caller that already proved `apiKey` against the provider's
   * own probe before calling `seedCatalog`. A plain `workbench seed`
   * never sets this, since its key comes straight from env with no
   * probe of its own.
   */
  credentialVerified?: boolean;
  /**
   * A credential row the caller already planted (the shared
   * persist-and-seed sequence, `@corbits/connections`'
   * `persistConnectorCredential`). When set, this function plants only
   * the catalog side — provider/credential ensure is skipped entirely,
   * so the caller's single `ensureCredential` stays the one write (no
   * second rotation PATCH against the same row).
   */
  existingCredentialId?: string;
  /**
   * Overrides `CATALOG_SEEDS[provider].provider.baseURL` for this seed
   * run — the configurable-base-URL seam every other curated provider
   * ignores (a fixed origin) and `ollama` uses (the root a person
   * actually pointed their instance at). Accepted in any shape
   * `ollamaOpenAICompatBaseURL` normalizes (plain root or `/v1` form);
   * normalized here before it reaches `ensureProvider`/`ensureCatalogProvider`.
   * Ignored for every provider except `ollama`.
   */
  baseURLOverride?: string;
};

export type SeedCatalogResult = {
  /**
   * Whether at least one seeded offering is completion-capable per
   * `hasCompletionCapableModel`. `false` only when every seeded model
   * resolves to no capability data and an embedding-shaped name (a fresh
   * Ollama connect whose instance has only an embedding model pulled,
   * most concretely, CL-6351) -- the connect itself still succeeds, but
   * the caller (`connections`' `/complete` route) surfaces this as a
   * guided state rather than letting every chat turn fail with "does not
   * support generate".
   */
  hasCompletionCapableModel: boolean;
};

/**
 * Plants one provider's curated catalog (see `catalog-seed-data.ts`) in a
 * tenant's catalog. The catalog model rows are always planted — data
 * only, viewable before any credential exists. The credential, catalog
 * provider, and offerings are planted only when a real `apiKey` is given
 * or `placeholderCredential` is explicitly set; without either, the
 * models are listable but nothing is launchable, and the caller is told
 * so. Idempotent: an already seeded chain is detected by name and
 * skipped, never duplicated.
 */
export async function seedCatalog(args: SeedCatalogArgs): Promise<SeedCatalogResult> {
  const { api, cookies, tenantId, log, provider = "anthropic" } = args;
  const seed = CATALOG_SEEDS[provider];

  if (args.placeholderCredential === true && OAUTH_ONLY_CATALOG_PROVIDERS.has(provider)) {
    throw new PlaceholderCredentialError(
      `provider "${provider}" has no API-key credential path — a placeholder ` +
        `secret could never authenticate. Connect it through its OAuth login ` +
        `or seed a real token instead.`,
    );
  }

  const providerBaseURL =
    provider === "ollama"
      ? ollamaOpenAICompatBaseURL(args.baseURLOverride ?? seed.provider.baseURL)
      : seed.provider.baseURL;

  // Ollama's whole catalog is whatever the instance actually has loaded
  // right now — the curated static seed (two names, kept in sync by
  // hand) is only the fallback for an unreachable instance. Every other
  // provider's model list is fixed, so this never runs for them.
  const dynamicModels: readonly CatalogModelSpec[] | undefined =
    provider === "ollama" ? await fetchOllamaModelCatalog(providerBaseURL) : undefined;
  const models = dynamicModels ?? seed.models;

  const seededModels: {
    id: string;
    canonicalName: string;
    liveCapabilities?: readonly string[];
  }[] = [];
  for (const model of models) {
    const modelId = await ensureCatalogModel(
      api,
      cookies,
      { tenantId, canonicalName: model.canonicalName },
      log,
    );
    seededModels.push(
      model.capabilities !== undefined
        ? {
            id: modelId,
            canonicalName: model.canonicalName,
            liveCapabilities: model.capabilities,
          }
        : { id: modelId, canonicalName: model.canonicalName },
    );
  }

  const credentialSecret =
    args.apiKey ?? (args.placeholderCredential === true ? PLACEHOLDER_CATALOG_API_KEY : undefined);

  const providerArgs = {
    tenantId,
    name: seed.provider.name,
    plugin: seed.provider.plugin,
    apiBaseUrl: providerBaseURL,
  };

  async function plantCredential(secret: string): Promise<string> {
    const providerId = await ensureProvider(api, cookies, providerArgs, log);
    const baseCredentialArgs = {
      tenantId,
      providerId,
      name: args.credentialName ?? inferenceCredentialName(seed.provider.name),
      secret,
      type: args.credentialType ?? ("api_key" as const),
      verified: args.credentialVerified ?? false,
    };
    return ensureCredential(
      api,
      cookies,
      args.credentialMetadata !== undefined
        ? { ...baseCredentialArgs, metadata: args.credentialMetadata }
        : baseCredentialArgs,
      log,
    );
  }
  let credentialId: string;
  if (args.existingCredentialId !== undefined) {
    await ensureProvider(api, cookies, providerArgs, log);
    credentialId = args.existingCredentialId;
  } else if (credentialSecret !== undefined) {
    credentialId = await plantCredential(credentialSecret);
  } else {
    log(
      `catalog models for ${seed.provider.name} seeded without a credential; ` +
        `no workbench or workflow can launch against them until a ${seed.provider.name} API key is connected — connect one in the UI's provider step, or set it here and re-run: workbench seed`,
    );
    return {
      hasCompletionCapableModel: hasCompletionCapableModel(
        models,
        (model) => model.capabilities ?? [],
        (model) => model.canonicalName,
      ),
    };
  }
  const catalogProviderId = await ensureCatalogProvider(
    api,
    cookies,
    {
      tenantId,
      name: seed.provider.name,
      plugin: seed.provider.plugin,
      baseURL: providerBaseURL,
      credentialId,
    },
    log,
  );
  // Flatten the curated provider/model declaration order into one priority
  // sequence. Provider order still controls cross-provider fallback, while
  // model order makes each provider's declared default the first choice.
  let offeringPriorityOffset = 0;
  for (const [seedProvider, providerSeed] of Object.entries(CATALOG_SEEDS)) {
    if (seedProvider === provider) break;
    offeringPriorityOffset += providerSeed.models.length;
  }
  // What each deployment can do, resolved from the pinned catalog's probe
  // results. Until this, every seeded offering stored an empty capability
  // list, so no capability filter — this repo's concept resolution or the
  // platform's own source resolution — could answer anything. A deployment
  // the catalog has never probed still gets an empty list: an honest "not
  // known" beats a guess that routes real work to a model that cannot do it.
  const unprobed: string[] = [];
  const offeredCapabilities: {
    canonicalName: string;
    capabilities: readonly string[];
  }[] = [];
  for (const [modelIndex, model] of seededModels.entries()) {
    // Ollama's dynamic entries already carry their own live-probed
    // capabilities (`fetchOllamaModelCatalog`, CL-6366) — narrowed against
    // the real `Capability` enum here, the trust boundary, rather than
    // trusted as the instance reported them. Every curated seed entry has
    // no live probe of its own, so it still resolves from the pinned
    // catalog exactly as before.
    const capabilities =
      model.liveCapabilities !== undefined
        ? model.liveCapabilities.filter(
            (capability): capability is Capability =>
              !(Capability(capability) instanceof type.errors),
          )
        : capabilitiesForDeployment({
            plugin: seed.provider.plugin,
            baseURL: providerBaseURL,
            canonicalName: model.canonicalName,
          }).capabilities;
    if (capabilities.length === 0) unprobed.push(model.canonicalName);
    offeredCapabilities.push({
      canonicalName: model.canonicalName,
      capabilities,
    });
    // Ollama's own openai-compatible endpoint otherwise falls back to a
    // small built-in context window and `@intx/inference`'s built-in
    // adapter falls back to 4096 output tokens -- both silent, both
    // truncating a real conversation. `quirksForDeployment` resolves this
    // model's real ceiling (or `undefined` for a provider outside this
    // mechanism's scope, or a model this catalog has not vetted a ceiling
    // for), landing on the offering's `quirks` column exactly the way
    // `capabilitiesForDeployment` lands on its `capabilities` column. A
    // provider whose seed declares its own bag (Codex's host identity)
    // uses that instead — one quirks source per provider, never both.
    const quirks =
      seed.provider.quirks ??
      quirksForDeployment({
        providerName: seed.provider.name,
        canonicalName: model.canonicalName,
      });
    await ensureCatalogOffering(
      api,
      cookies,
      {
        tenantId,
        modelId: model.id,
        providerId: catalogProviderId,
        priority: offeringPriorityOffset + modelIndex,
        capabilities,
        ...(quirks !== undefined ? { quirks } : {}),
      },
      log,
    );
  }
  if (unprobed.length > 0) {
    log(
      `no capability data for ${unprobed.join(", ")} — these models are listable and launchable, but nothing that picks a model by what it can do will offer them yet`,
    );
  }

  log(`catalog ready: ${seed.provider.name}/${models.map((m) => m.canonicalName).join(", ")}`);
  return {
    hasCompletionCapableModel: hasCompletionCapableModel(
      offeredCapabilities,
      (offering) => offering.capabilities,
      (offering) => offering.canonicalName,
    ),
  };
}

// The noop-inference offering planter (`ensureNoopCatalogOffering`) that
// used to live here moved to `scripts/e2e/noop-inference-server.ts`
// (CL-8160): the hub no longer mounts a noop-inference route at all, so
// planting a catalog offering against one is exclusively an e2e-suite
// concern now, not something this connect-time planting module should
// know about. That file reuses `ensureCatalogModel`, `ensureProvider`,
// `ensureCredential`, `ensureCatalogProvider`, and `ensureCatalogOffering`
// exported from here against its own tiny local noop server.
