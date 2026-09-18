// The sanctioned path for a workflow-process child to add itself a
// capability, authenticated through `WorkflowRunAuthenticator`. No
// grant-store check — see docs/workflow-capability-authorization.md.
import { type } from "arktype";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

import type { DB } from "@intx/db";
import { workflowDefinition, workflowRun } from "@intx/db/schema";
import type { AssetService } from "@intx/hub-sessions";

import { commitAgentCapabilityAdd } from "./capability-add";
import {
  AddCapabilityInput,
  assertCapabilityInInventory,
  CapabilityOutOfInventoryError,
  type CapabilityInventoryProvider,
} from "./capability-inventory";
import {
  RetiredWorkflowEnvelopeError,
  statusForAgentDefinitionDeployError,
  WorkflowAuthorError,
  type AgentDefinitionDeployer,
} from "./definition-asset";
import type { PinnedSkillIndexResolver } from "./routes";
import { makeErrorEnvelope } from "@corbits/error-sink";

/** The tenant + principal + run a sidecar token and run address resolve
 * to. Declared structurally so this package carries no dependency on the
 * artifacts plane. */
export type WorkflowCapabilityRunScope = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly runId: string;
};

export type WorkflowRunAuthenticator = {
  resolve(token: string, runAddress: string): Promise<WorkflowCapabilityRunScope | null>;
};

export type WorkflowCapabilitiesEnv = {
  Variables: { workflowCapabilityScope: WorkflowCapabilityRunScope };
};

function definitionNotFound(definitionId: string) {
  return makeErrorEnvelope({
    code: "not_found",
    userMessage: `No agent definition "${definitionId}" in this workbench`,
  });
}

/** Same host-guard `./routes.ts` applies: a workbench host is never a
 * target a workflow run may mutate through this surface either. */
function hostGuardedRow(
  row: { readonly name: string; readonly assetId: string | null } | undefined,
): row is { readonly name: string; readonly assetId: string } {
  return row !== undefined && row.assetId !== null;
}

export type CreateWorkflowCapabilityRoutesDeps = {
  db: DB["db"];
  assetService: AssetService;
  skillIndex: PinnedSkillIndexResolver;
  capabilityInventory: CapabilityInventoryProvider;
  authenticator: WorkflowRunAuthenticator;
  /** Deploys the definition's commit through the native source pipeline
   * after the rewrite. */
  deployer: AgentDefinitionDeployer;
};

export function createWorkflowCapabilityRoutes(
  deps: CreateWorkflowCapabilityRoutesDeps,
): Hono<WorkflowCapabilitiesEnv> {
  const app = new Hono<WorkflowCapabilitiesEnv>();

  app.onError((err, c) => {
    if (err instanceof CapabilityOutOfInventoryError) {
      return c.json(makeErrorEnvelope({ code: "bad_request", userMessage: err.message }), 400);
    }
    if (err instanceof RetiredWorkflowEnvelopeError) {
      return c.json(makeErrorEnvelope({ code: "conflict", userMessage: err.message }), 409);
    }
    if (err instanceof WorkflowAuthorError) {
      return c.json(
        makeErrorEnvelope({ code: err.reason, userMessage: err.message }),
        statusForAgentDefinitionDeployError(err.reason),
      );
    }
    throw err;
  });

  app.use("*", async (c, next) => {
    const authHeader = c.req.header("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
    const address = c.req.header("x-workflow-run-address") ?? "";
    const scope = await deps.authenticator.resolve(token, address);
    if (scope === null) {
      return c.json(
        makeErrorEnvelope({
          code: "unauthorized",
          userMessage: "Missing or unrecognized sidecar bearer token / run address",
        }),
        401,
      );
    }
    c.set("workflowCapabilityScope", scope);
    await next();
  });

  app.get("/inventory", async (c) => {
    const scope = c.get("workflowCapabilityScope");
    const inventory = await deps.capabilityInventory.resolve({
      tenantId: scope.tenantId,
      principalId: scope.principalId,
    });
    return c.json(inventory);
  });

  app.post("/:definitionId/capabilities", async (c) => {
    const scope = c.get("workflowCapabilityScope");
    const definitionId = c.req.param("definitionId");

    // A run may only ever touch its own definition through this surface.
    const run = await deps.db.query.workflowRun.findFirst({
      where: eq(workflowRun.id, scope.runId),
    });
    if (run === undefined || run.definitionId !== definitionId) {
      return c.json(
        makeErrorEnvelope({
          code: "forbidden",
          userMessage: "A workflow run may only request capabilities for its own agent definition",
        }),
        403,
      );
    }

    const body = AddCapabilityInput(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: `invalid capability: ${body.summary}`,
        }),
        400,
      );
    }

    const row = await deps.db.query.workflowDefinition.findFirst({
      where: and(
        eq(workflowDefinition.id, definitionId),
        eq(workflowDefinition.tenantId, scope.tenantId),
      ),
    });
    if (!hostGuardedRow(row)) {
      return c.json(definitionNotFound(definitionId), 404);
    }

    const inventory = await deps.capabilityInventory.resolve({
      tenantId: scope.tenantId,
      principalId: scope.principalId,
    });
    // Throws `CapabilityOutOfInventoryError`, caught by `app.onError`.
    assertCapabilityInInventory(body, inventory);

    const added = await commitAgentCapabilityAdd({
      db: deps.db,
      assetService: deps.assetService,
      deployer: deps.deployer,
      skillIndex: deps.skillIndex,
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      assetId: row.assetId,
      handle: row.name,
      body,
    });
    return c.json(added);
  });

  return app;
}
