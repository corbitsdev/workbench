// Env-key auto-plant (CL-6101): the hub-boot counterpart to `workbench
// seed`'s ANTHROPIC_API_KEY handling and to this package's own
// `completeCredentialSetup` (the guided credential step). Where those
// two plant a credential for a person who is either running the CLI by
// hand or pasting a key into the wizard, this module plants one for
// every curated provider whose conventional env var the hub's own
// process was started with — so an operator who sets ANTHROPIC_API_KEY
// (or any other curated provider's key) in the hub's environment gets a
// launchable catalog the moment the hub boots, with no `workbench seed`
// re-run and no manual step.
//
// Never reimplements credential planting: the live probe is
// `testProviderCredential` and the actual plant is `seedCatalog` (same
// `@workbench/hub-client` functions `completeCredentialSetup` calls),
// reused here exactly as onboarding's own guided step uses them. This
// module's only job is the env-map-to-provider translation, the
// idempotency check that skips overwriting a provider already carrying
// a working credential (never rotating a renamed key), backfills that
// provider's curated catalog additively on every hub boot, and folding
// a single provider's failure into a log line instead of an exception —
// one bad or rate-limited key must never stop every other provider from
// planting, and must never stop the hub itself from starting.

import {
  CredentialResponse,
  paginatedSchema,
  ProviderResponse,
} from "@intx/types";
import { reportError } from "@corbits/error-sink";
import {
  inferenceCredentialName,
  OLLAMA_PLACEHOLDER_SECRET,
  parseAs,
  seedCatalog,
  testProviderCredential,
  type ApiCall,
  type SeedCatalogArgs,
  type SupportedCredentialProvider,
  type TestProviderCredentialArgs,
} from "@workbench/hub-client";

/**
 * The conventional environment variable name(s) each curated provider's
 * key is read from. Listed in the order `CATALOG_SEEDS` declares
 * providers, so a log or docs listing built by iterating this map reads
 * in the same order the catalog itself does. `google-genai` accepts
 * either of the two names the ecosystem actually uses for a Gemini key
 * — `GEMINI_API_KEY` first (Google's own current SDKs read this one),
 * falling back to `GOOGLE_API_KEY` — rather than picking one and
 * silently ignoring whichever an operator happens to already have set.
 */
export const PROVIDER_ENV_VARS: Readonly<
  Record<SupportedCredentialProvider, readonly string[]>
> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  "google-genai": ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  xai: ["XAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  "opencode-zen": ["OPENCODE_ZEN_API_KEY"],
  groq: ["GROQ_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  huggingface: ["HUGGINGFACE_API_KEY"],
  // Not a secret — see `OLLAMA_PLACEHOLDER_SECRET`. Listed here so the
  // env-var-per-provider convention this map documents stays complete;
  // `envProviderKeysFrom`/`envProviderBaseUrlsFrom` below give this one
  // provider's entry different treatment: presence plants the fixed
  // placeholder secret, and the value itself is read separately as the
  // instance's base URL.
  ollama: ["OLLAMA_BASE_URL"],
};

/**
 * Reads `PROVIDER_ENV_VARS` out of a raw environment map, first
 * matching name wins per provider. Pure and side-effect-free so a
 * caller (the hub's own `readHubConfig`) can arktype-parse the
 * individual variables first and still land on this same mapping.
 * `ollama` is the one provider whose env var is not itself a secret:
 * `OLLAMA_BASE_URL`'s mere presence plants the fixed
 * `OLLAMA_PLACEHOLDER_SECRET`, never the URL itself — the URL is read
 * separately by `envProviderBaseUrlsFrom`.
 */
export function envProviderKeysFrom(
  env: Record<string, string | undefined>,
): Partial<Record<SupportedCredentialProvider, string>> {
  const keys: Partial<Record<SupportedCredentialProvider, string>> = {};
  for (const [provider, names] of Object.entries(PROVIDER_ENV_VARS) as [
    SupportedCredentialProvider,
    readonly string[],
  ][]) {
    for (const name of names) {
      const value = env[name];
      if (value !== undefined && value.length > 0) {
        keys[provider] =
          provider === "ollama" ? OLLAMA_PLACEHOLDER_SECRET : value;
        break;
      }
    }
  }
  return keys;
}

/**
 * The base-URL counterpart to `envProviderKeysFrom`: every curated
 * provider has a fixed origin except `ollama`, whose `OLLAMA_BASE_URL`
 * env var names the actual instance (local or tailscale-tunneled) to
 * plant a credential against. Empty for every other provider — this map
 * only ever carries the one entry today.
 */
export function envProviderBaseUrlsFrom(
  env: Record<string, string | undefined>,
): Partial<Record<SupportedCredentialProvider, string>> {
  const baseUrls: Partial<Record<SupportedCredentialProvider, string>> = {};
  const value = env["OLLAMA_BASE_URL"];
  if (value !== undefined && value.length > 0) {
    baseUrls.ollama = value;
  }
  return baseUrls;
}

export type PlantEnvProviderCredentialsOutcome = {
  readonly provider: SupportedCredentialProvider;
  readonly status: "planted" | "skipped" | "failed" | "blocked";
  /** A probe-error summary on `failed`; never the key itself. */
  readonly message?: string;
};

/**
 * Strips token-shaped substrings (`sk-…`, `hf_…`, and similar
 * provider-key prefixes) out of a probe error message before it is
 * logged. Providers sometimes echo a truncated form of the rejected key
 * back in their error body (OpenAI does this); this must never reach a
 * log line.
 */
function sanitizeProviderMessage(message: string): string {
  return message.replace(
    /\b(sk|pk|xai|gsk|hf|or)[-_][A-Za-z0-9_-]{6,}\b/g,
    "[redacted]",
  );
}

export type PlantEnvProviderCredentialsArgs = {
  api: ApiCall;
  cookies: string[];
  tenantId: string;
  /** provider -> API key, e.g. from `envProviderKeysFrom`. */
  envProviderKeys: Partial<Record<SupportedCredentialProvider, string>>;
  /** provider -> configured base URL, e.g. from `envProviderBaseUrlsFrom`.
   * Only `ollama` ever carries an entry today; every other provider's
   * probe and seed run against its own fixed origin regardless of what
   * (if anything) this map holds for it. */
  envProviderBaseUrls?: Partial<Record<SupportedCredentialProvider, string>>;
  /** One line per provider: name, outcome, and (on failure) a probe
   * error summary — never the key. */
  log: (line: string) => void;
  testCredential?: (
    args: TestProviderCredentialArgs,
  ) => ReturnType<typeof testProviderCredential>;
  seedCatalogFn?: (args: SeedCatalogArgs) => ReturnType<typeof seedCatalog>;
};

/**
 * Looks up the provider row a curated provider's connections (env-plant
 * and a Settings connect alike) both key their credential to —
 * `persistConnectorCredential` and `seedCatalog`'s own `plantCredential`
 * both `ensureProvider` this exact `{ name: provider }` pair, so a
 * provider row's existence here means some path already connected this
 * provider. Read-only: unlike `ensureProvider`, this never creates the
 * row, so a provider nobody has connected yet correctly reads back as
 * "no active credential" without planting a stub row ahead of a probe
 * that might still fail. Paginated the same way `findActiveCredential`
 * is — a tenant with enough providers to span a page must not lose a
 * match that lands on page two.
 */
async function findProviderId(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
  provider: SupportedCredentialProvider,
): Promise<string | undefined> {
  let cursor: string | undefined;
  do {
    const path =
      cursor === undefined
        ? `/api/tenants/${tenantId}/providers?inherited=false`
        : `/api/tenants/${tenantId}/providers?inherited=false&cursor=${encodeURIComponent(cursor)}`;
    const listed = await api("GET", path, undefined, cookies);
    const page = parseAs(
      paginatedSchema(ProviderResponse),
      listed.data,
      "providers response",
    );
    const match = page.data.find((p) => p.name === provider);
    if (match !== undefined) return match.id;
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return undefined;
}

/**
 * An active credential is recognized by the provider row it belongs to
 * (`providerId`), not by the credential's own name — a Settings-connected
 * credential is named after the connector's `displayName` ("Anthropic"),
 * while this module's own plant names its row
 * `inferenceCredentialName(provider)` ("anthropic-default"). Both
 * resolve to the same provider row (`findProviderId`), so matching on
 * `providerId` recognizes either one instead of only the env-plant's own
 * naming convention. Restricted to the credential types `seedCatalog`
 * itself ever writes for an inference source (`api_key`, `oauth_token`)
 * so a non-inference row that happens to share the provider (never
 * planted by either path today, but not a case this match should ever
 * be fooled by) can't count as the plant.
 */
async function findActiveCredential(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
  providerId: string,
): Promise<{ id: string; name: string } | undefined> {
  let cursor: string | undefined;
  do {
    const path =
      cursor === undefined
        ? `/api/tenants/${tenantId}/credentials`
        : `/api/tenants/${tenantId}/credentials?cursor=${encodeURIComponent(cursor)}`;
    const listed = await api("GET", path, undefined, cookies);
    const page = parseAs(
      paginatedSchema(CredentialResponse),
      listed.data,
      "credentials response",
    );
    const match = page.data.find(
      (c) =>
        c.providerId === providerId &&
        c.status === "active" &&
        (c.type === "api_key" || c.type === "oauth_token"),
    );
    if (match !== undefined) return { id: match.id, name: match.name };
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return undefined;
}

/**
 * Plants a credential (and its curated catalog) for every provider
 * present in `envProviderKeys`, at the given tenant, idempotently:
 *
 * - A provider already carrying an active credential of that name is
 *   not probed and its key is not overwritten — an already-rotated or
 *   hand-renamed key stays put. `seedCatalog` still runs against that
 *   existing credential (`existingCredentialId`, no `apiKey`) so a
 *   hub restart backfills newly curated models additively. `seedCatalog`
 *   is ensure-then-create: missing rows are planted, existing ones
 *   409-skip, nothing is deleted.
 * - A provider with no existing credential is proven with a real,
 *   free call (`testProviderCredential`) before anything is persisted;
 *   a failed probe is reported and skipped, never thrown, so one bad
 *   or rate-limited key never stops the rest of the providers (or the
 *   hub itself) from starting.
 * - A proven key is planted through `seedCatalog` — the same function
 *   `workbench seed` and onboarding's own guided step use — so a
 *   workbench or workflow can launch against it immediately. `seedCatalog`
 *   is re-verified afterward: if a same-named but non-active credential
 *   already existed, `seedCatalog` 409-skips it rather than storing the
 *   proven key, and this is reported honestly as `"blocked"` — never
 *   logged as planted.
 *
 * Calling this twice with the same env plants the credential once: the
 * second call's per-provider check skips probe and key write, then
 * backfills the curated catalog against the already-active row.
 */
export async function plantEnvProviderCredentials(
  args: PlantEnvProviderCredentialsArgs,
): Promise<PlantEnvProviderCredentialsOutcome[]> {
  const testCredential = args.testCredential ?? testProviderCredential;
  const runSeedCatalog = args.seedCatalogFn ?? seedCatalog;
  const outcomes: PlantEnvProviderCredentialsOutcome[] = [];
  const suppressedLog = () => {
    // seedCatalog's own step-by-step log is suppressed here: this
    // module reports exactly one summary line per provider below,
    // never the per-row created/skipped detail seedCatalog logs for
    // its other callers (`workbench seed`, the guided step).
  };

  function catalogSeedArgs(
    provider: SupportedCredentialProvider,
    extra:
      { readonly apiKey: string } | { readonly existingCredentialId: string },
  ): SeedCatalogArgs {
    const baseURL = args.envProviderBaseUrls?.[provider];
    return {
      api: args.api,
      cookies: args.cookies,
      tenantId: args.tenantId,
      provider,
      log: suppressedLog,
      ...extra,
      ...(baseURL !== undefined ? { baseURLOverride: baseURL } : {}),
    };
  }

  for (const [provider, apiKey] of Object.entries(args.envProviderKeys) as [
    SupportedCredentialProvider,
    string,
  ][]) {
    const providerId = await findProviderId(
      args.api,
      args.cookies,
      args.tenantId,
      provider,
    );
    const alreadyActive =
      providerId !== undefined
        ? await findActiveCredential(
            args.api,
            args.cookies,
            args.tenantId,
            providerId,
          )
        : undefined;
    if (alreadyActive) {
      const name = alreadyActive.name;
      try {
        await runSeedCatalog(
          catalogSeedArgs(provider, {
            existingCredentialId: alreadyActive.id,
          }),
        );
      } catch (cause) {
        reportError(cause, {
          operation: "env_credential_plant_backfill_catalog",
          tenantId: args.tenantId,
          extra: { provider },
        });
        // Never the raw cause detail (this module handles a live API
        // key, CL-7234) — sanitizeProviderMessage is the same redaction
        // the probe-failure path below already applies.
        const message = sanitizeProviderMessage(
          cause instanceof Error ? cause.message : String(cause),
        );
        args.log(
          `env credential plant: ${provider} failed to backfill catalog: ${message}`,
        );
        outcomes.push({ provider, status: "failed", message });
        continue;
      }
      args.log(
        `env credential plant: ${provider} already has an active credential named ${name} (skipped) — the env key was not planted; rotate the existing ${name} credential in Plugins if you meant to replace it. Curated catalog models were backfilled additively.`,
      );
      outcomes.push({ provider, status: "skipped" });
      continue;
    }

    const baseURL = args.envProviderBaseUrls?.[provider];
    const probe = await testCredential(
      baseURL !== undefined
        ? { provider, apiKey, baseURL }
        : { provider, apiKey },
    );
    if (!probe.ok) {
      const sanitized = sanitizeProviderMessage(probe.message);
      args.log(`env credential plant: ${provider} probe failed: ${sanitized}`);
      outcomes.push({ provider, status: "failed", message: sanitized });
      continue;
    }

    try {
      await runSeedCatalog(catalogSeedArgs(provider, { apiKey }));
    } catch (cause) {
      reportError(cause, {
        operation: "env_credential_plant",
        tenantId: args.tenantId,
        extra: { provider },
      });
      // Never the raw cause detail — this catch runs right after a live
      // API key was used to seed the catalog (CL-7234).
      const message = sanitizeProviderMessage(
        cause instanceof Error ? cause.message : String(cause),
      );
      args.log(`env credential plant: ${provider} failed to plant: ${message}`);
      outcomes.push({ provider, status: "failed", message });
      continue;
    }

    // `seedCatalog`'s `ensureCredential` treats a same-named existing
    // credential as a 409 conflict and, for `api_key` rows, never
    // rotates it — so a revoked/expired credential left over under the
    // same name silently blocks the proven env key from ever being
    // stored. `findActiveCredential` already ruled out an *active*
    // credential before the probe; re-checking now is the only way to
    // tell "planted" apart from "409-skipped against a dead row". The
    // provider row is guaranteed to exist by now — `seedCatalog` just
    // `ensureProvider`d it while planting.
    const nowProviderId = await findProviderId(
      args.api,
      args.cookies,
      args.tenantId,
      provider,
    );
    const nowActive =
      nowProviderId !== undefined
        ? await findActiveCredential(
            args.api,
            args.cookies,
            args.tenantId,
            nowProviderId,
          )
        : undefined;
    if (!nowActive) {
      const name = inferenceCredentialName(provider);
      args.log(
        `env credential plant: ${provider} was NOT planted — a credential named ${name} already exists but is not active; your proven env key was not stored. Remove or rotate the existing ${name} credential in Plugins, then restart the hub.`,
      );
      outcomes.push({ provider, status: "blocked" });
      continue;
    }

    args.log(`env credential plant: ${provider} planted (catalog ready)`);
    outcomes.push({ provider, status: "planted" });
  }

  return outcomes;
}
