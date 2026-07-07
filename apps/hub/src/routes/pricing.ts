import type { DB } from "@intx/db";
import { getLogger } from "@intx/log";
import { Hono, type Env } from "hono";

import { getProviderLogo, loadPriceCatalog } from "../lib/pricing";
import { getOfferingProvidersByModel } from "../services/offering-providers-by-model";

const log = getLogger(["hub", "pricing"]);

type PricingRouteEnv = Env & {
  Variables: {
    tenant: { id: string };
    principal: { id: string };
  };
};

const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Exposes the hub-cached models.dev pricing catalog and proxied provider logos.
 * Mounted at `/api/tenants/:tenantId/pricing` — membership-gated like the other
 * tenant reads. The browser consumes these (never models.dev directly) so the
 * catalog stays same-origin and inside CSP.
 */
export type CreatePricingRouterDeps = {
  db: DB["db"];
};

export function createPricingRouter({
  db,
}: CreatePricingRouterDeps): Hono<PricingRouteEnv> {
  const app = new Hono<PricingRouteEnv>();

  app.get("/", async (c) => {
    try {
      const tenant = c.get("tenant");
      const catalog = await loadPriceCatalog();
      const offeringProvidersByModel = await getOfferingProvidersByModel(
        db,
        tenant.id,
      );
      return c.json({ ...catalog, offeringProvidersByModel });
    } catch (error) {
      log.error("Pricing catalog load failed: {error}", {
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        {
          error: {
            code: "pricing_unavailable",
            message: "Model pricing is temporarily unavailable",
          },
        },
        503,
      );
    }
  });

  app.get("/logos/:provider", async (c) => {
    const provider = c.req.param("provider").replace(/\.svg$/, "");
    if (!PROVIDER_PATTERN.test(provider)) {
      return c.json(
        { error: { code: "bad_request", message: "Invalid provider" } },
        400,
      );
    }
    try {
      const svg = await getProviderLogo(provider);
      if (svg === null) {
        return c.json(
          { error: { code: "not_found", message: "No logo for provider" } },
          404,
        );
      }
      c.header("Content-Type", "image/svg+xml");
      c.header("Cache-Control", "public, max-age=3600");
      return c.body(svg);
    } catch (error) {
      log.error("Provider logo fetch failed for {provider}: {error}", {
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        { error: { code: "not_found", message: "No logo for provider" } },
        404,
      );
    }
  });

  return app;
}
