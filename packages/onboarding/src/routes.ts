// `POST /provision`, mounted outside the hub's tenant-prefixed routes
// because a brand-new user belongs to no tenant yet: authenticated,
// idempotent, and answering either the provisioning result or the hub's
// `{ error: { code, message } }` envelope. What it decides and why lives
// in ./provision.ts.

import type { AppEnv } from "@intx/hub-api";
import { createNoopCredentialCipher } from "@intx/crypto";
import { CredentialResponse, paginatedSchema } from "@intx/types";
import type { CredentialCipher } from "@intx/types";
import {
  cookiesFromHeader,
  createHubAPI,
  DEFAULT_WORKFLOWS,
  inferenceCredentialName,
  isCliError,
  parseAs,
  supportedCredentialProviders,
  type ApiCall,
  type ModelSource,
  type SupportedCredentialProvider,
  type WorkflowPusher,
} from "@workbench/hub-client";
import { Hono } from "hono";
import { type } from "arktype";
import type { AccessPolicyStore } from "@workbench/access-policy";

import {
  isFullySeeded,
  personalTenantSlug,
  provisionPersonalTenantIfNeeded,
  ProvisionError,
} from "./provision";

import {
  completeCredentialSetup,
  ensureSeeded,
  findPersonalTenant,
  testAndPersistCredential,
  type EnsureSeededResult,
  type PersonalTenant,
  type TestAndPersistCredentialResult,
} from "./complete-credential";
import {
  CONNECTOR_REGISTRY,
  createOAuthConnectRoutes,
  DEFAULT_RETURN_PATH_ALLOWLIST,
  type ConnectorDescriptor,
  type OAuthExchangeResult,
} from "@workbench/connections";
import type { PendingSeedStore } from "./pending-seed";
import { exchangeCodeForKey } from "./openrouter-connect";
import { exchangeCodeForToken as exchangeHuggingFaceCodeForToken } from "./huggingface-connect";
import type { ProviderHealthStore } from "@workbench/connections/provider-health";

function assertNonEmpty<T>(arr: T[]): asserts arr is [T, ...T[]] {
  if (arr.length === 0) {
    throw new Error("expected a non-empty array");
  }
}

const providerIds = supportedCredentialProviders().map((p) => p.id);
assertNonEmpty(providerIds);

const SubmitCredential = type({
  provider: type.enumerated(...providerIds),
  apiKey: "string > 0",
  // Ollama's card collects a URL instead of a key (see the onboarding
  // page's own `ProviderCardButton`/credential form); `apiKey` still
  // carries the fixed `OLLAMA_PLACEHOLDER_SECRET` for that provider, and
  // this optional field carries the actual instance URL. Absent for
  // every other provider.
  "baseURL?": "string > 0",
});

const ProvisionBody = type({
  "name?": "string > 0",
});

export type CreateOnboardingRoutesDeps = {
  hubUrl: string;
  operatorTenantId?: string;
  seedModel?: ModelSource;
  pushWorkflow: WorkflowPusher;
  log: (line: string) => void;
  /** Error-level sibling of `log`: every server-side failure path in
   * these routes reports here so the hub's global logger records it at
   * error severity, not as an info line that vanishes under filtering. */
  logError?: (line: string) => void;
  openrouterConnect?: {
    exchange?: typeof exchangeCodeForKey;
    /** The fast half only — persists the code-exchanged key as a
     * credential, no probe gating it (CL-6123). Never deploys a
     * workflow; see `complete-credential.ts`'s module comment for why
     * the callback route must never run more than this before
     * redirecting. */
    connectCredential?: typeof testAndPersistCredential;
  };
  /** The public OAuth app id from huggingface.co/settings/applications
   * (see docs/onboarding-huggingface-connect.md). Absent disables the
   * connect card's routes without disabling anything else — HF stays
   * available as a paste-a-token provider either way. */
  huggingfaceClientId?: string;
  huggingfaceConnect?: {
    exchange?: typeof exchangeHuggingFaceCodeForToken;
    connectCredential?: typeof testAndPersistCredential;
  };
  /** Test seam for `POST /complete-setup`'s slow-path deploy step. */
  ensureSeededFn?: typeof ensureSeeded;
  /** Test seam for `POST /complete`'s own success path — defaults to the
   * real `completeCredentialSetup`. */
  completeCredentialSetupFn?: typeof completeCredentialSetup;
  /**
   * The same provider-health signal `@workbench/connections`' own routes
   * write to (CL-6092): a successful `POST /complete` clears any stale
   * needs-attention record for the connected provider, so the shell
   * banner's onboarding-routed "Fix it" (the zero-working-providers case)
   * doesn't survive the very fix it sent someone to make. Absent means no
   * health store is wired in — the clear is a no-op, matching every other
   * optional dep here.
   */
  providerHealth?: ProviderHealthStore;
  /** Server-side custody for a just-connected credential's plaintext
   * key between the OAuth callback and this package's own
   * `/complete-setup` follow-up — see `./pending-seed.ts`'s module
   * comment for why this replaced an HttpOnly cookie (CL-6031). Built
   * from `createDrizzlePendingSeedStore(db, credentialCipher)` in
   * production; tests inject `createInMemoryPendingSeedStore`. */
  pendingSeedStore: PendingSeedStore;
  /** The closed-by-default access-policy gate threaded straight into
   * `provisionPersonalTenantIfNeeded` — see that function's own
   * `accessPolicy` doc comment. Absent means no access-policy package
   * is wired in at all; never a valid production shape. */
  accessPolicy?: {
    store: AccessPolicyStore;
    envSignupMode: "open" | "closed";
    envAllowedDomains: readonly string[];
    allowUnverifiedEmails: boolean;
  };
  /** Seals the OAuth connect state (PKCE verifier included) parked
   * between `/start` and `/callback`, so a hub restart in between
   * doesn't strand it — see `@workbench/connections`' `pkce.ts`. The same `CredentialCipher`
   * every other secret-at-rest seam in the hub shares
   * (`CREDENTIAL_ENCRYPTION_KEY`, `apps/hub`'s `credentialCipherFrom`).
   * Defaults to the identity no-op cipher: fine for dev/test, never for
   * a real deployment. */
  credentialCipher?: CredentialCipher;
};

type CompleteSetupOutcome = { readonly kind: "unseeded" } | EnsureSeededResult;

/**
 * The idempotent-duplicate-callback recovery: when a callback's own
 * single-use state comes back already consumed, that is not on its own
 * proof the connection failed — a browser that fires the same callback
 * twice (a double navigation, a retried request) burns the state on its
 * first, successful arrival and only ever sees `state_expired` on the
 * second. Before reporting that as a failure, check whether this exact
 * session's user already has an active credential for this provider,
 * created recently enough that it can only be the twin of this same
 * round trip — never a coincidence from some unrelated, older connect.
 * A genuinely expired or wrong-session state still finds nothing here
 * and errors honestly. This is best-effort recovery, never load-bearing
 * for correctness: any failure reading the hub (it being briefly
 * unreachable, a malformed response) is treated the same as "found
 * nothing" — the caller falls back to its ordinary `state_expired`
 * ending rather than surfacing a second, unrelated failure mode.
 */
async function recentlyConnectedCredential(
  api: ApiCall,
  cookies: string[],
  args: {
    userId: string;
    userEmail: string;
    provider: SupportedCredentialProvider;
    withinMs: number;
    log: (line: string) => void;
    now?: () => number;
  },
): Promise<PersonalTenant | undefined> {
  const now = args.now ?? Date.now;
  try {
    const expectedSlug = personalTenantSlug(args.userEmail, args.userId);
    const tenant = await findPersonalTenant(api, cookies, expectedSlug);
    if (!tenant) return undefined;

    const listed = await api(
      "GET",
      `/api/tenants/${tenant.tenantId}/credentials`,
      undefined,
      cookies,
    );
    const credentials = parseAs(
      paginatedSchema(CredentialResponse),
      listed.data,
      "credentials response",
    ).data;
    const name = inferenceCredentialName(args.provider);
    const cutoff = now() - args.withinMs;
    const match = credentials.find(
      (credential) =>
        credential.name === name &&
        credential.status === "active" &&
        Date.parse(credential.createdAt) >= cutoff,
    );
    return match ? tenant : undefined;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    args.log(
      `duplicate-callback recovery check failed for user ${args.userId}: ${message}`,
    );
    return undefined;
  }
}

export function createOnboardingRoutes(
  deps: CreateOnboardingRoutesDeps,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const api = createHubAPI(deps.hubUrl);
  const credentialCipher =
    deps.credentialCipher ?? createNoopCredentialCipher();

  // A simple in-process per-user provision rate limiter. Provisioning is
  // idempotent and safe to retry, but a client stuck in a tight retry loop
  // (or a runaway script) can pile concurrent tenant creates onto the hub.
  // One in-flight or recent provision per user is enough; the window is
  // short because successful provisioning resolves immediately.
  const PROVISION_RATE_LIMIT_MS = 10_000;
  const lastProvisionByUser = new Map<string, number>();
  const completeSetupInFlight = new Map<
    string,
    Promise<CompleteSetupOutcome>
  >();

  async function completeSetupOnce(args: {
    userId: string;
    cookies: string[];
    tenant: PersonalTenant;
  }): Promise<CompleteSetupOutcome> {
    const key = JSON.stringify([args.userId, args.tenant.tenantId]);
    const existing = completeSetupInFlight.get(key);
    if (existing) return existing;

    const operation = (async (): Promise<CompleteSetupOutcome> => {
      const fullySeeded = await isFullySeeded(
        api,
        args.cookies,
        args.tenant.tenantId,
      );
      if (fullySeeded) {
        await deps.pendingSeedStore.clear({
          userId: args.userId,
          tenantId: args.tenant.tenantId,
        });
        return {
          kind: "seeded",
          workflows: DEFAULT_WORKFLOWS.map((workflow) => workflow.assetName),
        };
      }

      const pending = await deps.pendingSeedStore.read({
        userId: args.userId,
        tenantId: args.tenant.tenantId,
      });
      if (pending === undefined) return { kind: "unseeded" };

      const runEnsureSeeded = deps.ensureSeededFn ?? ensureSeeded;
      const seeded = await runEnsureSeeded({
        api,
        cookies: args.cookies,
        hubUrl: deps.hubUrl,
        pushWorkflow: deps.pushWorkflow,
        log: deps.log,
        tenant: args.tenant,
        provider: pending.provider,
        apiKey: pending.apiKey,
      });

      if (seeded.kind === "seeded") {
        await deps.pendingSeedStore.clear({
          userId: args.userId,
          tenantId: args.tenant.tenantId,
        });
      }
      return seeded;
    })();

    completeSetupInFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      if (completeSetupInFlight.get(key) === operation) {
        completeSetupInFlight.delete(key);
      }
    }
  }

  app.post("/provision", async (c) => {
    const user = c.get("user");
    if (!user) {
      return c.json(
        { error: { code: "unauthorized", message: "Authentication required" } },
        401,
      );
    }

    // Optional body: the naming wizard sends `{ name }`; the shell's
    // membership probe may POST with no body and only wants the read path.
    // Parse before rate-limiting so the read probe never burns a create slot.
    // Empty body → probe. Present body that is not valid JSON or fails the
    // schema → 400 (never silently treated as a probe).
    const bodyText = await c.req.text();
    let body: { name?: string } | undefined;
    if (bodyText.trim() === "") {
      body = undefined;
    } else {
      let rawBody: unknown;
      try {
        rawBody = JSON.parse(bodyText) as unknown;
      } catch {
        return c.json(
          {
            error: {
              code: "bad_request",
              message: "Request body must be valid JSON",
            },
          },
          400,
        );
      }
      const parsed = ProvisionBody(rawBody);
      if (parsed instanceof type.errors) {
        return c.json(
          {
            error: {
              code: "bad_request",
              message: "Invalid provision body",
            },
          },
          400,
        );
      }
      body = parsed;
    }
    const isCreateAttempt = body?.name !== undefined;

    // Rate-limit only named creates. The two-step first-login flow is
    // probe (no name) → naming submit (with name); gating both would 429
    // anyone who types a name within the window of their membership probe.
    if (isCreateAttempt) {
      const now = Date.now();
      const lastAttempt = lastProvisionByUser.get(user.id);
      if (
        lastAttempt !== undefined &&
        now - lastAttempt < PROVISION_RATE_LIMIT_MS
      ) {
        return c.json(
          {
            error: {
              code: "rate_limited",
              kind: "transient" as const,
              message:
                "Too many provisioning attempts. Please wait a moment and try again.",
            },
          },
          429,
        );
      }
      lastProvisionByUser.set(user.id, now);
    }

    const cookies = cookiesFromHeader(c.req.header("cookie"));
    try {
      const provisionArgs: Parameters<
        typeof provisionPersonalTenantIfNeeded
      >[0] = {
        api,
        cookies,
        hubUrl: deps.hubUrl,
        userId: user.id,
        userEmail: user.email,
        userEmailVerified: user.emailVerified,
        pushWorkflow: deps.pushWorkflow,
        log: deps.log,
      };
      if (deps.operatorTenantId !== undefined)
        provisionArgs.operatorTenantId = deps.operatorTenantId;
      if (deps.seedModel !== undefined)
        provisionArgs.seedModel = deps.seedModel;
      if (body?.name !== undefined) provisionArgs.displayName = body.name;
      if (deps.accessPolicy !== undefined)
        provisionArgs.accessPolicy = deps.accessPolicy;

      const result = await provisionPersonalTenantIfNeeded(provisionArgs);

      return c.json(result, 200);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      deps.log(
        `first-login provisioning failed for user ${user.id}: ${message}`,
      );
      if (cause instanceof ProvisionError) {
        const status =
          cause.code === "signup_not_allowed"
            ? 403
            : cause.errorKind === "transient"
              ? 503
              : 500;
        return c.json(
          {
            error: {
              code: cause.code,
              kind: cause.errorKind,
              message: cause.message,
            },
          },
          status,
        );
      }
      // An unrecognized error is treated as transient — the hub may have
      // been momentarily unavailable, and retrying is safe because
      // provisioning is idempotent.
      return c.json(
        {
          error: {
            code: "provisioning_failed",
            kind: "transient" as const,
            message:
              "Could not provision a workbench for this account. Try again in a moment.",
          },
        },
        503,
      );
    }
  });

  // OAuth connect (OpenRouter, Hugging Face): CL-6028 generalized both
  // providers' start/callback mechanics into `@workbench/connections`'
  // `createOAuthConnectRoutes` — state sealing, PKCE, cookies, rate
  // limiting, and the duplicate-callback recovery shape all live there
  // now, driven by `CONNECTOR_REGISTRY`'s `openrouter`/`huggingface`
  // entries. What stays here, unchanged: persisting the exchanged
  // material (`testAndPersistCredential`, the fast half — no probe, no
  // workflow deploy), the duplicate-callback recovery lookup
  // (`recentlyConnectedCredential`, below), and writing the pending-seed
  // row the deferred `/complete-setup` deploy step reads (see
  // `./pending-seed.ts`). Every test seam this package's deps already
  // exposed (`openrouterConnect`/`huggingfaceConnect` overrides) still
  // works — they're threaded into the registry entries' `oauth.exchange`
  // below.

  /**
   * Adapts `packages/onboarding`'s pre-CL-6028 exchange function shape
   * (`{code, codeVerifier} -> {ok, key}|{ok, message}`, still what
   * `deps.openrouterConnect.exchange` overrides in tests) onto
   * `ConnectorOAuthConfig.exchange`'s generalized shape.
   */
  function adaptOpenRouterExchange(
    exchange: typeof exchangeCodeForKey = deps.openrouterConnect?.exchange ??
      exchangeCodeForKey,
  ) {
    return async (args: {
      code: string;
      codeVerifier?: string;
      redirectUri: string;
      clientId?: string;
    }): Promise<OAuthExchangeResult> => {
      const result = await exchange({
        code: args.code,
        codeVerifier: args.codeVerifier ?? "",
      });
      return result.ok ? { ok: true, apiKey: result.key } : result;
    };
  }

  function adaptHuggingFaceExchange(
    exchange: typeof exchangeHuggingFaceCodeForToken = deps.huggingfaceConnect
      ?.exchange ?? exchangeHuggingFaceCodeForToken,
  ) {
    return async (args: {
      code: string;
      codeVerifier?: string;
      redirectUri: string;
      clientId?: string;
    }): Promise<OAuthExchangeResult> => {
      if (args.clientId === undefined) {
        return {
          ok: false,
          message: "huggingface connect is not configured",
        };
      }
      const result = await exchange({
        code: args.code,
        codeVerifier: args.codeVerifier ?? "",
        redirectUri: args.redirectUri,
        clientId: args.clientId,
      });
      if (!result.ok) return result;
      return result.expiresAt !== undefined
        ? { ok: true, apiKey: result.accessToken, expiresAt: result.expiresAt }
        : { ok: true, apiKey: result.accessToken };
    };
  }

  const openrouterDescriptor = CONNECTOR_REGISTRY["openrouter"];
  const huggingfaceDescriptor = CONNECTOR_REGISTRY["huggingface"];
  if (openrouterDescriptor?.oauth === undefined) {
    throw new Error(
      "@workbench/connections' registry is missing the openrouter oauth-pkce entry",
    );
  }
  if (huggingfaceDescriptor?.oauth === undefined) {
    throw new Error(
      "@workbench/connections' registry is missing the huggingface oauth-pkce entry",
    );
  }
  const oauthRegistry: Readonly<Record<string, ConnectorDescriptor>> = {
    ...CONNECTOR_REGISTRY,
    openrouter: {
      ...openrouterDescriptor,
      oauth: {
        ...openrouterDescriptor.oauth,
        exchange: adaptOpenRouterExchange(),
      },
    },
    huggingface: {
      ...huggingfaceDescriptor,
      oauth: {
        ...huggingfaceDescriptor.oauth,
        exchange: adaptHuggingFaceExchange(),
      },
    },
  };

  /** The fast half only — persists the exchanged material, no probe,
   * never deploys a workflow. Dispatches to whichever provider's own
   * test-seam override (`deps.openrouterConnect`/`deps.huggingfaceConnect`)
   * applies, defaulting both to `testAndPersistCredential`. */
  async function connectCredential(args: {
    connectorId: string;
    userId: string;
    userEmail: string;
    cookies: string[];
    apiKey: string;
    credentialMetadata?: Record<string, unknown>;
  }): Promise<TestAndPersistCredentialResult> {
    const provider = args.connectorId as SupportedCredentialProvider;
    const impl =
      provider === "openrouter"
        ? (deps.openrouterConnect?.connectCredential ??
          testAndPersistCredential)
        : (deps.huggingfaceConnect?.connectCredential ??
          testAndPersistCredential);
    const connectCredentialArgs = {
      api,
      cookies: args.cookies,
      hubUrl: deps.hubUrl,
      userId: args.userId,
      userEmail: args.userEmail,
      provider,
      apiKey: args.apiKey,
      pushWorkflow: deps.pushWorkflow,
      log: deps.log,
    };
    return impl(
      args.credentialMetadata !== undefined
        ? {
            ...connectCredentialArgs,
            credentialMetadata: args.credentialMetadata,
          }
        : connectCredentialArgs,
    );
  }

  async function recentlyConnected(args: {
    connectorId: string;
    userId: string;
    userEmail: string;
    cookies: string[];
    withinMs: number;
  }): Promise<PersonalTenant | undefined> {
    return recentlyConnectedCredential(api, args.cookies, {
      userId: args.userId,
      userEmail: args.userEmail,
      provider: args.connectorId as SupportedCredentialProvider,
      withinMs: args.withinMs,
      log: deps.log,
    });
  }

  /** Runs only for a connector whose `oauth.deploysDefaultWorkflows` is
   * true (both OpenRouter and Hugging Face) — writes the plaintext
   * material into the pending-seed store `/complete-setup` reads, so
   * the deferred workflow deploy never blocks this redirect. The
   * browser gets nothing from this call: no cookie, no ciphertext, only
   * the ordinary redirect — see `./pending-seed.ts`'s module comment. */
  async function afterConnected(args: {
    c: import("hono").Context;
    connectorId: string;
    userId: string;
    apiKey: string;
    tenantId: string;
    tenantSlug: string;
    principalId: string;
    tenantDomain: string;
  }): Promise<void> {
    const provider = args.connectorId as SupportedCredentialProvider;
    await deps.pendingSeedStore.put({
      userId: args.userId,
      tenantId: args.tenantId,
      principalId: args.principalId,
      tenantDomain: args.tenantDomain,
      provider,
      apiKey: args.apiKey,
    });
  }

  app.route(
    "/oauth",
    createOAuthConnectRoutes({
      hubUrl: deps.hubUrl,
      log: deps.log,
      credentialCipher,
      registry: oauthRegistry,
      oauthEnv: { huggingfaceClientId: deps.huggingfaceClientId },
      connectCredential,
      recentlyConnected,
      afterConnected,
      defaultReturnPath: "/onboarding",
      // The plugins gallery (CL-6090) reuses this same onboarding OAuth
      // route for its one-flow connect panel — `/plugins` joins the
      // default allowlist rather than widening
      // `DEFAULT_RETURN_PATH_ALLOWLIST` itself, per that constant's own
      // doc comment.
      returnPathAllowlist: [...DEFAULT_RETURN_PATH_ALLOWLIST, "/plugins"],
    }),
  );

  app.post("/complete", async (c) => {
    const user = c.get("user");
    if (!user) {
      return c.json(
        { error: { code: "unauthorized", message: "Authentication required" } },
        401,
      );
    }

    const body: unknown = await c.req.json().catch(() => null);
    const parsed = SubmitCredential(body);
    if (parsed instanceof type.errors) {
      return c.json(
        {
          error: {
            code: "invalid_request",
            message: `A provider and an API key are required: ${parsed.summary}`,
          },
        },
        400,
      );
    }

    const cookies = cookiesFromHeader(c.req.header("cookie"));
    const runCompleteCredentialSetup =
      deps.completeCredentialSetupFn ?? completeCredentialSetup;
    const baseCompleteCredentialArgs = {
      api,
      cookies,
      hubUrl: deps.hubUrl,
      userId: user.id,
      userEmail: user.email,
      provider: parsed.provider,
      apiKey: parsed.apiKey,
      pushWorkflow: deps.pushWorkflow,
      log: deps.log,
    };
    try {
      const result = await runCompleteCredentialSetup(
        parsed.baseURL !== undefined
          ? { ...baseCompleteCredentialArgs, baseURLOverride: parsed.baseURL }
          : baseCompleteCredentialArgs,
      );

      if (result.kind === "invalid-credential") {
        return c.json(
          { error: { code: "invalid_credential", message: result.message } },
          422,
        );
      }
      if (result.kind === "no-personal-bench") {
        return c.json(
          {
            error: {
              code: "no_personal_bench",
              message:
                "No personal bench was found for this account yet. Reload and try again.",
            },
          },
          409,
        );
      }
      // The credential is durably seeded — clear any stale needs-attention
      // record for this provider (CL-6092), the same clear-on-success rule
      // `@workbench/connections`' own routes follow. This runs for both
      // `seeded` and `seeded-pending-agents`: the credential itself is
      // proven-durable in either case, only the workflow deploy is still
      // catching up.
      deps.providerHealth?.clear(result.tenantId, parsed.provider);
      if (result.kind === "seeded-pending-agents") {
        // CL-6264: reuses the same pending-seed row an OAuth connect
        // writes (`./pending-seed.ts`) rather than a new queue, so this
        // account's next `POST /complete-setup` (the onboarding page's
        // own reload follow-up) picks up exactly where the sidecar-down
        // deploy left off and finishes the remaining default workflows.
        await deps.pendingSeedStore.put({
          userId: user.id,
          tenantId: result.tenantId,
          principalId: result.principalId,
          tenantDomain: result.tenantDomain,
          provider: parsed.provider,
          apiKey: parsed.apiKey,
        });
      }
      return c.json(result, 200);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      (deps.logError ?? deps.log)(
        `credential setup failed for user ${user.id}: ${message}`,
      );
      // ProvisionError and CliError messages are both written to be shown
      // (they name the actual step that failed); anything else stays
      // behind the generic sentence rather than leaking an internal error
      // shape at a user.
      const shown =
        cause instanceof ProvisionError || isCliError(cause)
          ? `Your key was added, but setting up your workbench failed: ${cause.message}.`
          : "Your key was added, but setting up your workbench failed. " +
            "The hub log has the underlying error.";
      return c.json(
        {
          error: {
            code: "credential_setup_failed",
            message: shown,
          },
        },
        500,
      );
    }
  });

  // Runs after the onboarding page lands — from a fresh connect
  // (`outcome=connected`) or a plain reload — and drives the slow half
  // the OAuth callback never runs: deploying the default workflows
  // against whichever credential is already on the caller's own
  // personal bench. Already-seeded is answered from a single read, no
  // pending token required, so a returning fully-set-up account (or a
  // second overlapping call once the first finishes) gets the same
  // `seeded` answer without redoing any work. `kind: "unseeded"` (200,
  // not an error) means there is nothing this call can do yet — no
  // pending credential to seed with — and the caller should fall back
  // to the ordinary credential step rather than treat it as a failure.
  app.post("/complete-setup", async (c) => {
    const user = c.get("user");
    if (!user) {
      return c.json(
        { error: { code: "unauthorized", message: "Authentication required" } },
        401,
      );
    }

    const cookies = cookiesFromHeader(c.req.header("cookie"));
    try {
      const expectedSlug = personalTenantSlug(user.email, user.id);
      const tenant = await findPersonalTenant(api, cookies, expectedSlug);
      if (!tenant) {
        return c.json(
          {
            error: {
              code: "no_personal_bench",
              message:
                "No personal bench was found for this account yet. Reload and try again.",
            },
          },
          409,
        );
      }

      const seeded = await completeSetupOnce({
        userId: user.id,
        cookies,
        tenant,
      });
      if (seeded.kind === "unseeded") {
        return c.json({ kind: "unseeded" }, 200);
      }

      if (seeded.kind === "seeded-pending-agents") {
        // Sidecar-unavailable (CL-6264): the pending row is left in
        // place, on purpose — it is exactly what lets the next
        // `POST /complete-setup` (another reload, or a retry the
        // onboarding page schedules itself) pick this back up and finish
        // the deferred workflows once the sidecar is back.
        return c.json(
          {
            kind: "seeded-pending-agents",
            tenantId: tenant.tenantId,
            tenantSlug: tenant.tenantSlug,
            deployed: seeded.deployed,
            pending: seeded.pending,
            message: seeded.message,
          },
          200,
        );
      }

      return c.json(
        {
          kind: "seeded",
          tenantId: tenant.tenantId,
          tenantSlug: tenant.tenantSlug,
          workflows: seeded.workflows,
        },
        200,
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      (deps.logError ?? deps.log)(
        `complete-setup failed for user ${user.id}: ${message}`,
      );
      return c.json(
        {
          error: {
            code: "complete_setup_failed",
            message:
              "Finishing your workbench setup failed. Try again in a moment.",
          },
        },
        500,
      );
    }
  });

  return app;
}
