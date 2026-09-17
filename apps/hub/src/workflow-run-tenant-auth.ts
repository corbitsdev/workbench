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
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { sha256 } from "@intx/crypto";
import type { DB } from "@intx/db";
import { sidecar, workflowRun } from "@intx/db/schema";
import {
  createWorkflowRunDeployAuth,
  type AppEnv,
  type WorkflowRunAuthenticator,
} from "@intx/hub-api";

export type WorkflowRunTenantAuthDeps = {
  db: DB["db"];
  authenticator: WorkflowRunAuthenticator;
};

/**
 * The tenant + principal + run a presented sidecar token and run address
 * resolve to. This is the one concrete implementation of the
 * `WorkflowRunAuthenticator` shape every workflow-run-authenticated surface
 * in this app takes structurally (agent-directory, chat, connections,
 * memory-hub, `@corbits/artifacts`' `mountWorkflowArtifacts`, and the
 * `withWorkflowRunTenantAuth` wrap below) — a single sidecar-token +
 * run-address check, reused everywhere rather than re-verified per surface.
 */
export type ResolvedWorkflowRunScope = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly runId: string;
};

export type CreateWorkflowRunAuthenticatorDeps = {
  db: DB["db"];
};

export type ConcreteWorkflowRunAuthenticator = {
  resolve(token: string, runAddress: string): Promise<ResolvedWorkflowRunScope | null>;
};

export function createWorkflowRunAuthenticator(
  deps: CreateWorkflowRunAuthenticatorDeps,
): ConcreteWorkflowRunAuthenticator {
  return {
    async resolve(token, runAddress) {
      if (token === "" || runAddress === "") return null;

      const tokenHash = await sha256(token);
      const sidecarRow = await deps.db.query.sidecar.findFirst({
        where: eq(sidecar.tokenHashSha256, tokenHash),
      });
      if (sidecarRow === undefined) return null;

      const run = await deps.db.query.workflowRun.findFirst({
        where: eq(workflowRun.address, runAddress),
      });
      if (run === undefined || run.principalId === null) return null;

      return {
        tenantId: run.tenantId,
        principalId: run.principalId,
        runId: run.id,
      };
    },
  };
}

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
