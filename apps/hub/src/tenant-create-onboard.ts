// CL-7584: the tenant-create trigger. Wrapped beside the access-policy
// guard (./tenant-create-guard.ts), this outer layer watches the native
// `POST /api/tenants` route: a 201 means a real tenant now exists that
// should converge onto the tenant desired-state document. The reconcile
// runs fire-and-forget under the creator's own session — the cookies
// that made the create are replayed, so no extra session is minted and
// the kick never touches the DB directly — so a fresh tenant gets Myra
// and the core pins without hub boot seeding anything.
//
// There is no durable work item here on purpose: the pending_seed row
// stays the only durable queue (a connect's credential), and a
// tenant-create kick that dies with the process is re-covered by the
// revisit kick (`POST /api/onboarding/provision`) on the next visit.
// In-process dedupe by tenantId is the same class of optimization the
// provisioner's in-flight map is: never a fact the system needs correct.
import { Hono } from "hono";
import type { AppEnv } from "@intx/hub-api";
import { cookiesFromHeader, type ApiCall } from "@corbits/hub-api-client";
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
  kick(args: { tenantId: string; cookies: string[] }): Promise<void>;
  /** Stops accepting new kicks. In-flight ones are not interrupted —
   * they run to their next HTTP call, which fails once the server has
   * stopped, and the failure is caught and logged. Hub shutdown calls
   * this before closing the DB and bounds the wait with `whenIdle`. */
  stop(): void;
  /** Resolves when every in-flight kick has finished or bailed. */
  whenIdle(): Promise<void>;
};

export function createTenantCreateObserver(
  deps: TenantCreateOnboardDeps,
  wrapped: Hono<AppEnv>,
): TenantCreateObserver {
  const logError = deps.logError ?? deps.log;
  // In-process tenantId dedupe, same pattern as the provisioner's
  // in-flight map: an optimization against double kicks, never a fact.
  const kicked = new Set<string>();
  const inFlight = new Set<Promise<void>>();
  let stopped = false;

  async function runReconcile(args: {
    tenantId: string;
    cookies: string[];
  }): Promise<void> {
    if (stopped) return;
    const cookies = args.cookies;
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

  function kick(args: { tenantId: string; cookies: string[] }): Promise<void> {
    if (stopped || kicked.has(args.tenantId)) return Promise.resolve();
    kicked.add(args.tenantId);
    const operation = runReconcile(args)
      .catch((cause: unknown) => {
        logError(
          `tenant-create onboarding for ${args.tenantId} failed (the revisit kick or drain will cover it): ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      })
      .finally(() => {
        kicked.delete(args.tenantId);
        inFlight.delete(operation);
      });
    inFlight.add(operation);
    return operation;
  }

  function stop(): void {
    stopped = true;
  }

  function whenIdle(): Promise<void> {
    return Promise.allSettled([...inFlight]).then(() => undefined);
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
    // The creator's own session cookies are replayed for the kick, so
    // it acts under the same session that made the create without
    // minting (or ever touching) anything of its own.
    const cookies = cookiesFromHeader(c.req.header("cookie"));
    if (cookies.length === 0) return;
    const body = (await c.res
      .clone()
      .json()
      .catch(() => undefined)) as
      { id?: unknown; tenantId?: unknown } | undefined;
    const tenantId =
      typeof body?.id === "string"
        ? body.id
        : typeof body?.tenantId === "string"
          ? body.tenantId
          : undefined;
    if (tenantId === undefined) return;
    // Fire-and-forget: a 201 must answer immediately.
    void kick({ tenantId, cookies });
  });
  app.route("/", wrapped);

  return { app, kick, stop, whenIdle };
}
