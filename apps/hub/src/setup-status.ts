// Native cold-boot setup status (CL-8112). A read-only, unauthenticated
// `GET /status` reporting whether this hub has ever been set up, derived
// from native user/tenant counts — the same genesis rule the seed path
// uses: zero tenants means no bench has ever been minted, so the first
// login must route into setup. Replaces the web first-login hook's old
// provision-POST read, which belonged to the unmounted onboarding router. No policy, no auth logic (those are
// T6/T7) — just counts.

import { Hono } from "hono";
import { makeErrorEnvelope, reportError } from "@corbits/error-sink";

export type SetupStatusCounts = {
  /** Native user-row count. */
  countUsers(): Promise<number>;
  /** Native tenant-row count. */
  countTenants(): Promise<number>;
};

export type SetupStatus = {
  readonly setupRequired: boolean;
  readonly userCount: number;
  readonly tenantCount: number;
};

export function createSetupStatusRoutes(deps: SetupStatusCounts): Hono {
  const app = new Hono();
  app.get("/status", async (c) => {
    try {
      const [userCount, tenantCount] = await Promise.all([
        deps.countUsers(),
        deps.countTenants(),
      ]);
      const body: SetupStatus = {
        setupRequired: tenantCount === 0,
        userCount,
        tenantCount,
      };
      return c.json(body);
    } catch (error) {
      const refId = reportError(error, { operation: "hub.setup_status" });
      return c.json(
        makeErrorEnvelope({
          code: "setup_status_failed",
          userMessage:
            "Checking whether this hub is set up hit a snag. Try again in a moment.",
          refId,
        }),
        500,
      );
    }
  });
  return app;
}
