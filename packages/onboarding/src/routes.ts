// `POST /provision`, mounted outside the hub's tenant-prefixed routes
// because a brand-new user belongs to no tenant yet: authenticated,
// idempotent, and answering either the provisioning result or the hub's
// `{ error: { code, message } }` envelope. What it decides and why lives
// in ./provision.ts.

import type { AppEnv } from "@intx/hub-api";
import { createNoopCredentialCipher } from "@intx/crypto";
import type { CredentialCipher } from "@intx/types";
import {
  createHubAPI,
  supportedCredentialProviders,
  testProviderCredential,
  type ModelSource,
  type SupportedCredentialProvider,
  type WorkflowPusher,
} from "@workbench/hub-client";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { type } from "arktype";
import { provisionPersonalTenantIfNeeded, ProvisionError } from "./provision";

import { completeCredentialSetup } from "./complete-credential";
import {
  createConnectStateStore,
  generatePKCEPair,
} from "@workbench/connections";
import { exchangeCodeForKey, OPENROUTER_AUTH_URL } from "./openrouter-connect";
import {
  exchangeCodeForToken as exchangeHuggingFaceCodeForToken,
  HUGGINGFACE_AUTHORIZE_URL,
  HUGGINGFACE_SCOPE,
} from "./huggingface-connect";

const PROVIDER_IDS = supportedCredentialProviders().map((p) => p.id) as [
  SupportedCredentialProvider,
  ...SupportedCredentialProvider[],
];

const SubmitCredential = type({
  provider: type.enumerated(...PROVIDER_IDS),
  apiKey: "string > 0",
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
  openrouterConnect?: {
    exchange?: typeof exchangeCodeForKey;
    completeSetup?: typeof completeCredentialSetup;
  };
  /** The public OAuth app id from huggingface.co/settings/applications
   * (see docs/onboarding-huggingface-connect.md). Absent disables the
   * connect card's routes without disabling anything else — HF stays
   * available as a paste-a-token provider either way. */
  huggingfaceClientId?: string;
  huggingfaceConnect?: {
    exchange?: typeof exchangeHuggingFaceCodeForToken;
    completeSetup?: typeof completeCredentialSetup;
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

function cookiesFromHeader(header: string | undefined): string[] {
  if (!header) return [];
  return header
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair.length > 0);
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
        pushWorkflow: deps.pushWorkflow,
        log: deps.log,
      };
      if (deps.operatorTenantId !== undefined)
        provisionArgs.operatorTenantId = deps.operatorTenantId;
      if (deps.seedModel !== undefined)
        provisionArgs.seedModel = deps.seedModel;
      if (body?.name !== undefined) provisionArgs.displayName = body.name;

      const result = await provisionPersonalTenantIfNeeded(provisionArgs);

      return c.json(result, 200);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      deps.log(
        `first-login provisioning failed for user ${user.id}: ${message}`,
      );
      if (cause instanceof ProvisionError) {
        const status = cause.errorKind === "transient" ? 503 : 500;
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

  // OpenRouter PKCE connect: /start parks a fresh verifier server-side
  // under a single-use state carried in an HttpOnly cookie, then sends
  // the browser to OpenRouter's consent page; /callback consumes that
  // state, trades the returned code for the user-scoped API key, and
  // finishes through the same test-then-seed path a pasted key takes.
  // Every outcome — success or failure — lands back in the wizard's
  // credential phase as query parameters; the key itself never appears
  // in a URL or a log line.
  const connectStates = createConnectStateStore({
    cipher: credentialCipher,
    provider: "openrouter",
  });
  const exchange = deps.openrouterConnect?.exchange ?? exchangeCodeForKey;
  const completeConnectedSetup =
    deps.openrouterConnect?.completeSetup ?? completeCredentialSetup;
  const CONNECT_STATE_COOKIE = "workbench_openrouter_connect";
  const secureCookies = deps.hubUrl.startsWith("https:");

  const wizardRedirectPath = (params: Record<string, string>): string => {
    const query = new URLSearchParams(params);
    query.set("connect", "openrouter");
    return `/onboarding?${query.toString()}`;
  };

  // The same in-process per-user limiter `/provision` uses, for the same
  // reason: every start parks a pending state, so a client stuck in a
  // redirect loop (or a runaway script) can grow the state map without
  // ever finishing a flow. One in-flight or recent start per user is
  // enough; a real consent round trip takes longer than the window.
  const CONNECT_START_RATE_LIMIT_MS = 10_000;
  const lastConnectStartByUser = new Map<string, number>();

  app.get("/oauth/openrouter/start", async (c) => {
    const user = c.get("user");
    if (!user) {
      return c.redirect(
        wizardRedirectPath({ outcome: "error", code: "signed_out" }),
        302,
      );
    }

    const now = Date.now();
    const lastStart = lastConnectStartByUser.get(user.id);
    if (
      lastStart !== undefined &&
      now - lastStart < CONNECT_START_RATE_LIMIT_MS
    ) {
      return c.redirect(
        wizardRedirectPath({ outcome: "error", code: "rate_limited" }),
        302,
      );
    }
    lastConnectStartByUser.set(user.id, now);

    const pkce = await generatePKCEPair();
    const state = await connectStates.issue({
      userId: user.id,
      codeVerifier: pkce.codeVerifier,
    });
    setCookie(c, CONNECT_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "Lax",
      secure: secureCookies,
      path: "/",
      maxAge: 600,
    });

    // Origin from configuration (the hub's public BASE_URL — the origin
    // OpenRouter must send the browser back to, whatever host header
    // this request arrived under), path from the request so the mount
    // prefix is never guessed at.
    const callbackUrl = new URL(
      c.req.path.replace(/\/start$/, "/callback"),
      deps.hubUrl,
    );
    const authUrl = new URL(OPENROUTER_AUTH_URL);
    authUrl.searchParams.set("callback_url", callbackUrl.toString());
    authUrl.searchParams.set("code_challenge", pkce.codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    return c.redirect(authUrl.toString(), 302);
  });

  app.get("/oauth/openrouter/callback", async (c) => {
    const user = c.get("user");
    if (!user) {
      return c.redirect(
        wizardRedirectPath({ outcome: "error", code: "signed_out" }),
        302,
      );
    }

    const state = getCookie(c, CONNECT_STATE_COOKIE);
    deleteCookie(c, CONNECT_STATE_COOKIE, { path: "/" });
    const code = c.req.query("code");
    if (state === undefined || code === undefined || code === "") {
      return c.redirect(
        wizardRedirectPath({ outcome: "error", code: "state_expired" }),
        302,
      );
    }
    const codeVerifier = await connectStates.consume({
      state,
      userId: user.id,
    });
    if (codeVerifier === undefined) {
      return c.redirect(
        wizardRedirectPath({ outcome: "error", code: "state_expired" }),
        302,
      );
    }

    const exchanged = await exchange({ code, codeVerifier });
    if (!exchanged.ok) {
      deps.log(
        `openrouter connect for user ${user.id}: code exchange failed: ${exchanged.message}`,
      );
      return c.redirect(
        wizardRedirectPath({ outcome: "error", code: "exchange_failed" }),
        302,
      );
    }

    const cookies = cookiesFromHeader(c.req.header("cookie"));
    try {
      const result = await completeConnectedSetup({
        api,
        cookies,
        hubUrl: deps.hubUrl,
        userId: user.id,
        userEmail: user.email,
        provider: "openrouter",
        apiKey: exchanged.key,
        pushWorkflow: deps.pushWorkflow,
        log: deps.log,
      });
      if (result.kind === "invalid-credential") {
        deps.log(
          `openrouter connect for user ${user.id}: minted key failed its probe: ${result.message}`,
        );
        return c.redirect(
          wizardRedirectPath({ outcome: "error", code: "key_rejected" }),
          302,
        );
      }
      if (result.kind === "no-personal-bench") {
        return c.redirect(
          wizardRedirectPath({ outcome: "error", code: "no_bench" }),
          302,
        );
      }
      return c.redirect(
        wizardRedirectPath({
          outcome: "seeded",
          tenantSlug: result.tenantSlug,
          workflows: result.workflows.join(","),
        }),
        302,
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      deps.log(
        `openrouter connect setup failed for user ${user.id}: ${message}`,
      );
      return c.redirect(
        wizardRedirectPath({ outcome: "error", code: "setup_failed" }),
        302,
      );
    }
  });

  // Hugging Face PKCE connect: the same shape as OpenRouter's above, with
  // two differences the provider forces. First, HF requires a registered
  // client id (no client secret — a public app), so `/start` 404s the
  // flow with a `not_configured` outcome when `deps.huggingfaceClientId`
  // is unset rather than crash. Second, HF's exchange returns a standard,
  // expiring OAuth access token — `expiresAt` (when HF reports
  // `expires_in`) is threaded into `completeCredentialSetup` as
  // credential metadata, never into a URL or a log line, alongside the
  // token itself.
  const huggingfaceConnectStates = createConnectStateStore({
    cipher: credentialCipher,
    provider: "huggingface",
  });
  const exchangeHuggingFace =
    deps.huggingfaceConnect?.exchange ?? exchangeHuggingFaceCodeForToken;
  const completeHuggingFaceSetup =
    deps.huggingfaceConnect?.completeSetup ?? completeCredentialSetup;
  const HUGGINGFACE_STATE_COOKIE = "workbench_huggingface_connect";

  const huggingfaceWizardRedirectPath = (
    params: Record<string, string>,
  ): string => {
    const query = new URLSearchParams(params);
    query.set("connect", "huggingface");
    return `/onboarding?${query.toString()}`;
  };

  const lastHuggingFaceConnectStartByUser = new Map<string, number>();

  app.get("/oauth/huggingface/start", async (c) => {
    const user = c.get("user");
    if (!user) {
      return c.redirect(
        huggingfaceWizardRedirectPath({ outcome: "error", code: "signed_out" }),
        302,
      );
    }
    if (deps.huggingfaceClientId === undefined) {
      return c.redirect(
        huggingfaceWizardRedirectPath({
          outcome: "error",
          code: "not_configured",
        }),
        302,
      );
    }

    const now = Date.now();
    const lastStart = lastHuggingFaceConnectStartByUser.get(user.id);
    if (
      lastStart !== undefined &&
      now - lastStart < CONNECT_START_RATE_LIMIT_MS
    ) {
      return c.redirect(
        huggingfaceWizardRedirectPath({
          outcome: "error",
          code: "rate_limited",
        }),
        302,
      );
    }
    lastHuggingFaceConnectStartByUser.set(user.id, now);

    const pkce = await generatePKCEPair();
    const state = await huggingfaceConnectStates.issue({
      userId: user.id,
      codeVerifier: pkce.codeVerifier,
    });
    setCookie(c, HUGGINGFACE_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "Lax",
      secure: secureCookies,
      path: "/",
      maxAge: 600,
    });

    const callbackUrl = new URL(
      c.req.path.replace(/\/start$/, "/callback"),
      deps.hubUrl,
    );
    const authUrl = new URL(HUGGINGFACE_AUTHORIZE_URL);
    authUrl.searchParams.set("client_id", deps.huggingfaceClientId);
    authUrl.searchParams.set("redirect_uri", callbackUrl.toString());
    authUrl.searchParams.set("scope", HUGGINGFACE_SCOPE);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", pkce.codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    return c.redirect(authUrl.toString(), 302);
  });

  app.get("/oauth/huggingface/callback", async (c) => {
    const user = c.get("user");
    if (!user) {
      return c.redirect(
        huggingfaceWizardRedirectPath({ outcome: "error", code: "signed_out" }),
        302,
      );
    }
    if (deps.huggingfaceClientId === undefined) {
      return c.redirect(
        huggingfaceWizardRedirectPath({
          outcome: "error",
          code: "not_configured",
        }),
        302,
      );
    }

    const cookieState = getCookie(c, HUGGINGFACE_STATE_COOKIE);
    deleteCookie(c, HUGGINGFACE_STATE_COOKIE, { path: "/" });
    const code = c.req.query("code");
    const queryState = c.req.query("state");
    // Belt and suspenders: HF echoes `state`, so a callback whose query
    // state disagrees with the cookie it arrived with is rejected before
    // the state store is even consulted, on top of the store's own
    // single-use/cross-user checks.
    if (
      cookieState === undefined ||
      queryState === undefined ||
      queryState !== cookieState ||
      code === undefined ||
      code === ""
    ) {
      return c.redirect(
        huggingfaceWizardRedirectPath({
          outcome: "error",
          code: "state_expired",
        }),
        302,
      );
    }
    const codeVerifier = await huggingfaceConnectStates.consume({
      state: cookieState,
      userId: user.id,
    });
    if (codeVerifier === undefined) {
      return c.redirect(
        huggingfaceWizardRedirectPath({
          outcome: "error",
          code: "state_expired",
        }),
        302,
      );
    }

    const callbackUrl = new URL(c.req.path, deps.hubUrl).toString();
    const exchanged = await exchangeHuggingFace({
      code,
      codeVerifier,
      redirectUri: callbackUrl,
      clientId: deps.huggingfaceClientId,
    });
    if (!exchanged.ok) {
      deps.log(
        `huggingface connect for user ${user.id}: code exchange failed: ${exchanged.message}`,
      );
      return c.redirect(
        huggingfaceWizardRedirectPath({
          outcome: "error",
          code: "exchange_failed",
        }),
        302,
      );
    }

    const cookies = cookiesFromHeader(c.req.header("cookie"));
    try {
      const result = await completeHuggingFaceSetup({
        api,
        cookies,
        hubUrl: deps.hubUrl,
        userId: user.id,
        userEmail: user.email,
        provider: "huggingface",
        apiKey: exchanged.accessToken,
        pushWorkflow: deps.pushWorkflow,
        log: deps.log,
        ...(exchanged.expiresAt !== undefined
          ? { credentialMetadata: { expiresAt: exchanged.expiresAt } }
          : {}),
      });
      if (result.kind === "invalid-credential") {
        deps.log(
          `huggingface connect for user ${user.id}: minted token failed its probe: ${result.message}`,
        );
        return c.redirect(
          huggingfaceWizardRedirectPath({
            outcome: "error",
            code: "key_rejected",
          }),
          302,
        );
      }
      if (result.kind === "no-personal-bench") {
        return c.redirect(
          huggingfaceWizardRedirectPath({ outcome: "error", code: "no_bench" }),
          302,
        );
      }
      return c.redirect(
        huggingfaceWizardRedirectPath({
          outcome: "seeded",
          tenantSlug: result.tenantSlug,
          workflows: result.workflows.join(","),
        }),
        302,
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      deps.log(
        `huggingface connect setup failed for user ${user.id}: ${message}`,
      );
      return c.redirect(
        huggingfaceWizardRedirectPath({
          outcome: "error",
          code: "setup_failed",
        }),
        302,
      );
    }
  });

  // A pure test: proves a key against the provider's real API before the
  // caller commits to anything. No credential is stored here — storage
  // and the rest of seeding only happen from `/complete`, and even that
  // stores through the hub's own `POST /api/tenants/:id/credentials`
  // route (see `complete-credential.ts`), never by reimplementing it.
  app.post("/credential/test", async (c) => {
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

    const result = await testProviderCredential({
      provider: parsed.provider,
      apiKey: parsed.apiKey,
    });
    if (!result.ok) {
      return c.json(
        { error: { code: "invalid_credential", message: result.message } },
        422,
      );
    }
    return c.json({ ok: true }, 200);
  });

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
    try {
      const result = await completeCredentialSetup({
        api,
        cookies,
        hubUrl: deps.hubUrl,
        userId: user.id,
        userEmail: user.email,
        provider: parsed.provider,
        apiKey: parsed.apiKey,
        pushWorkflow: deps.pushWorkflow,
        log: deps.log,
      });

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
      return c.json(result, 200);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      deps.log(`credential setup failed for user ${user.id}: ${message}`);
      return c.json(
        {
          error: {
            code: "credential_setup_failed",
            message:
              "The key checked out, but setting up your bench failed. Try again in a moment.",
          },
        },
        500,
      );
    }
  });

  return app;
}
