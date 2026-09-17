// A workflow child has no browser session — only its sidecar bearer token
// and its own run address. `@intx/hub-api` already knows how to turn that
// pair into a `principal` + `tenant` context (`createWorkflowRunDeployAuth`),
// but mounts it on the single `/api/tenants/:tenantId/workflows/deployments`
// path, so every other stock tenant route 401s a run-authenticated caller.
//
// This composition root widens that mount to the whole tenant subtree, so an
// agent tool package can read and write stock tenant routes (principals,
// grants, credentials, providers, offerings, workflow deployments) with the
// run bearer instead of a Workbench-specific `/api/workflow-*` mirror.
//
// It has to be an outer wrap rather than an `app.use()` on the built app:
// `createApp()` registers `createResolveTenant` on `/api/tenants/:tenantId/*`
// before it returns, and Hono composes middleware in registration order — the
// same reasoning `./tenant-create-guard.ts` and `./dispatch-tenant-guard.ts`
// give for their own wraps.
//
// The middleware is a no-op for a request that presents no bearer credential
// (it calls `next()` with nothing set), so session traffic, the git-token
// smart-HTTP mounts, and the existing deploy mirror all behave exactly as
// before. The `:tenantId` path segment is never trusted: the middleware sets
// the tenant from the authenticated run's own scope, so a run cannot widen
// its reach by naming another tenant in the URL.
import { Hono } from "hono";
import type { DB } from "@intx/db";
import {
  createWorkflowRunDeployAuth,
  type AppEnv,
  type WorkflowRunAuthenticator,
} from "@intx/hub-api";

export type WorkflowRunTenantAuthDeps = {
  db: DB["db"];
  authenticator: WorkflowRunAuthenticator;
};

export function withWorkflowRunTenantAuth(
  nativeApp: Hono<AppEnv>,
  deps: WorkflowRunTenantAuthDeps,
): Hono<AppEnv> {
  const wrapped = new Hono<AppEnv>();
  wrapped.use(
    "/api/tenants/:tenantId/*",
    createWorkflowRunDeployAuth({
      db: deps.db,
      authenticator: deps.authenticator,
    }),
  );
  wrapped.route("/", nativeApp);
  return wrapped;
}
