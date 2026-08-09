// `POST /provision`, mounted outside the hub's tenant-prefixed routes
// because a brand-new user belongs to no tenant yet: authenticated,
// idempotent, and answering either the provisioning result or the hub's
// `{ error: { code, message } }` envelope. What it decides and why lives
// in ./provision.ts.

import type { AppEnv } from "@intx/hub-api";
import {
  createHubAPI,
  supportedCredentialProviders,
  testProviderCredential,
  type ModelSource,
  type SupportedCredentialProvider,
  type WorkflowPusher,
} from "@workbench/hub-client";
import { Hono } from "hono";
import { type } from "arktype";
import { provisionPersonalTenantIfNeeded, ProvisionError } from "./provision";

import { completeCredentialSetup } from "./complete-credential";

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
    const rawBody: unknown = await c.req.json().catch(() => null);
    const body =
      rawBody === null
        ? undefined
        : (() => {
            const parsed = ProvisionBody(rawBody);
            return parsed instanceof type.errors ? undefined : parsed;
          })();
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
