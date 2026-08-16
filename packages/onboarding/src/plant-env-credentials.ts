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
// idempotency check that skips a provider already carrying a working
// credential (never overwriting a rotated or renamed key), and folding
// a single provider's failure into a log line instead of an exception —
// one bad or rate-limited key must never stop every other provider from
// planting, and must never stop the hub itself from starting.

import { CredentialResponse, paginatedSchema } from "@intx/types";
import {
  inferenceCredentialName,
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
};

/**
 * Reads `PROVIDER_ENV_VARS` out of a raw environment map, first
 * matching name wins per provider. Pure and side-effect-free so a
 * caller (the hub's own `readHubConfig`) can arktype-parse the
 * individual variables first and still land on this same mapping.
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
        keys[provider] = value;
        break;
      }
    }
  }
  return keys;
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
  /** One line per provider: name, outcome, and (on failure) a probe
   * error summary — never the key. */
  log: (line: string) => void;
  testCredential?: (
    args: TestProviderCredentialArgs,
  ) => ReturnType<typeof testProviderCredential>;
  seedCatalogFn?: (args: SeedCatalogArgs) => ReturnType<typeof seedCatalog>;
};

async function findActiveCredential(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
  provider: SupportedCredentialProvider,
): Promise<boolean> {
  const name = inferenceCredentialName(provider);
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
    if (page.data.some((c) => c.name === name && c.status === "active"))
      return true;
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return false;
}

/**
 * Plants a credential (and its curated catalog) for every provider
 * present in `envProviderKeys`, at the given tenant, idempotently:
 *
 * - A provider already carrying an active credential of that name is
 *   skipped outright — no live probe, no `seedCatalog` call — so an
 *   already-rotated or hand-renamed key is never touched, and a hub
 *   restart never re-probes a provider that already works.
 * - A provider with no existing credential is proven with a real,
 *   free call (`testProviderCredential`) before anything is persisted;
 *   a failed probe is reported and skipped, never thrown, so one bad
 *   or rate-limited key never stops the rest of the providers (or the
 *   hub itself) from starting.
 * - A proven key is planted through `seedCatalog` — the same function
 *   `workbench seed` and onboarding's own guided step use — so a
 *   channel or workflow can launch against it immediately. `seedCatalog`
 *   is re-verified afterward: if a same-named but non-active credential
 *   already existed, `seedCatalog` 409-skips it rather than storing the
 *   proven key, and this is reported honestly as `"blocked"` — never
 *   logged as planted.
 *
 * Calling this twice with the same env plants nothing the second time:
 * every provider it planted on the first call now has an active
 * credential, so the second call's per-provider check short-circuits
 * to "skipped" before any probe or plant runs.
 */
export async function plantEnvProviderCredentials(
  args: PlantEnvProviderCredentialsArgs,
): Promise<PlantEnvProviderCredentialsOutcome[]> {
  const testCredential = args.testCredential ?? testProviderCredential;
  const runSeedCatalog = args.seedCatalogFn ?? seedCatalog;
  const outcomes: PlantEnvProviderCredentialsOutcome[] = [];

  for (const [provider, apiKey] of Object.entries(args.envProviderKeys) as [
    SupportedCredentialProvider,
    string,
  ][]) {
    const alreadyActive = await findActiveCredential(
      args.api,
      args.cookies,
      args.tenantId,
      provider,
    );
    if (alreadyActive) {
      const name = inferenceCredentialName(provider);
      args.log(
        `env credential plant: ${provider} already has an active credential named ${name} (skipped) — the env key was not planted; rotate the existing ${name} credential in Plugins if you meant to replace it`,
      );
      outcomes.push({ provider, status: "skipped" });
      continue;
    }

    const probe = await testCredential({ provider, apiKey });
    if (!probe.ok) {
      const sanitized = sanitizeProviderMessage(probe.message);
      args.log(`env credential plant: ${provider} probe failed: ${sanitized}`);
      outcomes.push({ provider, status: "failed", message: sanitized });
      continue;
    }

    try {
      await runSeedCatalog({
        api: args.api,
        cookies: args.cookies,
        tenantId: args.tenantId,
        provider,
        apiKey,
        log: () => {
          // seedCatalog's own step-by-step log is suppressed here: this
          // module reports exactly one summary line per provider below,
          // never the per-row created/skipped detail seedCatalog logs
          // for its other callers (`workbench seed`, the guided step).
        },
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
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
    // tell "planted" apart from "409-skipped against a dead row".
    const nowActive = await findActiveCredential(
      args.api,
      args.cookies,
      args.tenantId,
      provider,
    );
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
