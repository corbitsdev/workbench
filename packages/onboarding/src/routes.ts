// `POST /provision`, mounted outside the hub's tenant-prefixed routes
// because a brand-new user belongs to no tenant yet: authenticated,
// idempotent, and answering either the provisioning result or the hub's
// `{ error: { code, message } }` envelope. What it decides and why lives
// in ./provision.ts.

import type { AppEnv } from "@intx/hub-api";
import {
  createHubAPI,
  type ModelSource,
  type WorkflowPusher,
} from "@workbench/hub-client";
import { Hono } from "hono";
import { type } from "arktype";
import { provisionPersonalTenantIfNeeded } from "./provision";
import { completeCredentialSetup } from "./complete-credential";

const SubmitCredential = type({ apiKey: "string > 0" });

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

  app.post("/provision", async (c) => {
    const user = c.get("user");
    if (!user) {
      return c.json(
        { error: { code: "unauthorized", message: "Authentication required" } },
        401,
      );
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

      const result = await provisionPersonalTenantIfNeeded(provisionArgs);

      return c.json(result, 200);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      deps.log(
        `first-login provisioning failed for user ${user.id}: ${message}`,
      );
      return c.json(
        {
          error: {
            code: "provisioning_failed",
            message:
              "Could not provision a workbench for this account. Try again in a moment.",
          },
        },
        500,
      );
    }
  });

  app.post("/credential", async (c) => {
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
            message: `An Anthropic API key is required: ${parsed.summary}`,
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
