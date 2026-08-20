// Authenticates a workflow-process child's HTTP call into the hub's
// workflow-artifacts surface (CL-6000). The child never holds a
// database handle or a browser session, so this is a bespoke,
// non-session credential check — modeled on (but not sharing code
// with) the vendored WS sidecar-token check in
// `vendor/intx/hub-sessions/src/ws/sidecar-token-authenticator.ts`,
// which is off-limits to edit.
//
// Two independent facts must both check out:
//
//   1. The presented bearer token hashes to a row on the `sidecar`
//      table — proof the caller IS a sidecar the hub provisioned. This
//      is the same trust anchor already injected into every
//      workflow-process child's spawn env for workflow-run pack-push
//      (`SIDECAR_TOKEN`); reused here rather than minting a second
//      credential the hub would have to track.
//   2. The presented run address resolves to a live folded run — binds
//      the call to that run's own tenant + principal, so a sidecar can
//      never act outside the run whose address it presents, even
//      though many runs can share one sidecar's token.
//
// Neither check alone is sufficient: a leaked run address without the
// sidecar token is inert, and a valid sidecar token names no
// tenant/principal by itself. The child never sees a database
// connection or a minted per-run secret — only its own run address
// (already carried in `BaseEnv.address`, see
// `apps/sidecar/src/workflow-substrate-factory/step-env.ts`) and the
// sidecar-wide token it already has.
import { eq } from "drizzle-orm";
import { sha256 } from "@intx/crypto";
import type { DB } from "@intx/db";
import { sidecar } from "@intx/db/schema";
import { findFoldedRunByAddress } from "@corbits/folded-runs";

export type ResolvedWorkflowRunScope = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly runId: string;
};

export type WorkflowRunAuthenticator = {
  resolve(
    token: string,
    runAddress: string,
  ): Promise<ResolvedWorkflowRunScope | null>;
};

export type CreateWorkflowRunAuthenticatorDeps = {
  db: DB["db"];
};

export function createWorkflowRunAuthenticator(
  deps: CreateWorkflowRunAuthenticatorDeps,
): WorkflowRunAuthenticator {
  return {
    async resolve(token, runAddress) {
      if (token === "" || runAddress === "") return null;

      const tokenHash = await sha256(token);
      const sidecarRow = await deps.db.query.sidecar.findFirst({
        where: eq(sidecar.tokenHashSha256, tokenHash),
      });
      if (sidecarRow === undefined) return null;

      const run = await findFoldedRunByAddress(deps.db, runAddress);
      if (run === undefined || run.principalId === null) return null;

      return {
        tenantId: run.tenantId,
        principalId: run.principalId,
        runId: run.id,
      };
    },
  };
}
