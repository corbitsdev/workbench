// CL-7584: the tenant-create trigger. Wrapped beside the access-policy
// guard (./tenant-create-guard.ts), this outer layer watches the native
// `POST /api/tenants` route: a 201 means a real tenant now exists that
// should converge onto the tenant desired-state document. The reconcile
// runs fire-and-forget under the creator's own minted session — the
// same `sessionFor` seam the pending-seed drain uses — so a fresh
// tenant gets Myra and the core pins without hub boot seeding anything.
//
// There is no durable work item here on purpose: the pending_seed row
// stays the only durable queue (a connect's credential), and a
// tenant-create kick that dies with the process is re-covered by the
// revisit kick (`POST /api/onboarding/provision`) on the next visit.
// In-process dedupe by tenantId is the same class of optimization the
// provisioner's in-flight map is: never a fact the system needs correct.
import { Hono } from "hono";
import type { AppEnv } from "@intx/hub-api";
import type { ApiCall } from "@corbits/hub-api-client";
import {
  reconcileTenantDesiredState,
  resolveTenantModelSource,
  TENANT_DESIRED_STATE,
  type ReconcileReport,
} from "@workbench/onboarding/desired-state";
import type { WorkflowPusher } from "@corbits/seeding";

export type TenantCreateOnboardDeps = {
  api: ApiCall;
  hubUrl: string;
  pushWorkflow: WorkflowPusher;
  /** Mints the creator's session so the reconcile acts under a real
   * user, exactly as the drain does. `undefined` skips the kick — a
   * session that cannot be minted is a later-pass problem, never a
   * failed create. */
  sessionFor: (args: {
    userId: string;
    tenantId: string;
  }) => Promise<string[] | undefined>;
  getSessionUser: (headers: Headers) => Promise<
    { id: string; email: string; emailVerified: boolean } | undefined
  >;
  log: (line: string) => void;
  logError?: (line: string) => void;
  /**
   * The convergence step. Production resolves the tenant's deploy model
   * from its resolved catalog and delegates to
   * `reconcileTenantDesiredState`; with no offerings it reports the
   * workflow pins blocked (logged, never thrown). Tests replace the
   * whole thing.
   */
  reconcileFn?: (args: {
    tenantId: string;
    cookies: string[];
  }) => Promise<ReconcileReport>;
};

export type TenantCreateObserver = {
  /** The composed app: observes `POST /api/tenants` 201s, then falls
   * through to the wrapped app. */
  app: Hono<AppEnv>;
  /** Kick a reconcile for one tenant directly (the revisit-kick wiring
   * shares this with the observer). Deduped per tenant in-process. */
  kick(args: { tenantId: string; creatorUserId: string }): Promise<void>;
};

export function createTenantCreateObserver(
  deps: TenantCreateOnboardDeps,
  wrapped: Hono<AppEnv>,
): TenantCreateObserver {
  const logError = deps.logError ?? deps.log;
  // In-process tenantId dedupe, same pattern as the provisioner's
  // in-flight map: an optimization against double kicks, never a fact.
  const kicked = new Set<string>();

  async function runReconcile(args: {
    tenantId: string;
    creatorUserId: string;
  }): Promise<void> {
    const cookies = await deps.sessionFor({
      userId: args.creatorUserId,
      tenantId: args.tenantId,
    });
    if (cookies === undefined) {
      deps.log(
        `tenant-create onboarding for ${args.tenantId} has no session to act under; the revisit kick or drain will cover it`,
      );
      return;
    }
    const reconcile =
      deps.reconcileFn ??
      (async (reconcileArgs: { tenantId: string; cookies: string[] }) => {
        const model = await resolveTenantModelSource(
          deps.api,
          reconcileArgs.cookies,
          reconcileArgs.tenantId,
        );
        if (model === undefined) {
          // No catalog offerings yet — nothing is launchable. Report the
          // workflow pins blocked; the next trigger (a connect's drain
          // pass, a revisit probe) sees the pins still pending and
          // re-kicks.
          deps.log(
            `tenant-create onboarding for ${reconcileArgs.tenantId} is blocked: no catalog offerings to deploy against yet`,
          );
          return {
            tenantId: reconcileArgs.tenantId,
            ready: false,
            pins: TENANT_DESIRED_STATE.workflows.map((pin) => ({
              name: pin.assetName,
              kind: "workflow" as const,
              status: "blocked" as const,
            })),
          } satisfies ReconcileReport;
        }
        return reconcileTenantDesiredState({
          api: deps.api,
          cookies: reconcileArgs.cookies,
          hubUrl: deps.hubUrl,
          tenant: { tenantId: reconcileArgs.tenantId },
          model,
          pushWorkflow: deps.pushWorkflow,
          log: deps.log,
        });
      });
    const report = await reconcile({ tenantId: args.tenantId, cookies });
    deps.log(
      `tenant-create onboarding for ${args.tenantId}: ${report.pins.length} pins, ready=${report.ready}`,
    );
  }

  async function kick(args: {
    tenantId: string;
    creatorUserId: string;
  }): Promise<void> {
    if (kicked.has(args.tenantId)) return;
    kicked.add(args.tenantId);
    try {
      await runReconcile(args);
    } catch (cause) {
      logError(
        `tenant-create onboarding for ${args.tenantId} failed (the revisit kick or drain will cover it): ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      kicked.delete(args.tenantId);
    }
  }

  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    await next();
    if (
      c.req.method !== "POST" ||
      c.req.path !== "/api/tenants" ||
      c.res.status !== 201
    ) {
      return;
    }
    // The creator's identity was already resolved and allowed by the
    // guard underneath; re-read it from the same headers for the
    // session mint.
    const user = await deps
      .getSessionUser(c.req.raw.headers)
      .catch(() => undefined);
    if (user === undefined) return;
    const body = (await c.res
      .clone()
      .json()
      .catch(() => undefined)) as
      | { id?: unknown; tenantId?: unknown }
      | undefined;
    const tenantId =
      typeof body?.id === "string"
        ? body.id
        : typeof body?.tenantId === "string"
          ? body.tenantId
          : undefined;
    if (tenantId === undefined) return;
    // Fire-and-forget: a 201 must answer immediately.
    void kick({ tenantId, creatorUserId: user.id });
  });
  app.route("/", wrapped);

  return { app, kick };
}
