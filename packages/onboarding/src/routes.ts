// The first-login hook's one route: mounted at `/api/onboarding`,
// outside the hub's tenant-prefixed routes (`/api/tenants/:tenantId/...`)
// and outside any tenant scope (a brand-new user belongs to none yet).
// Follows the same route-factory
// idiom as every other extension — one `app.route` line in the
// composition root, nothing more architectural.

import type { AppEnv } from "@intx/hub-api";
import {
  createHubAPI,
  type ModelSource,
  type WorkflowPusher,
} from "@workbench/hub-client";
import { Hono } from "hono";
import { provisionPersonalOrgIfNeeded } from "./provision";

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
      const provisionArgs: Parameters<typeof provisionPersonalOrgIfNeeded>[0] =
        {
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

      const result = await provisionPersonalOrgIfNeeded(provisionArgs);

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

  return app;
}
