// Gives a running workflow (Myra) a way to pin a skill onto any definition
// in its own tenant. `pin_skill` declares `approval: "ask"`, so a human
// already approved this exact pin before the route runs.
import { type } from "arktype";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

import type { DB } from "@intx/db";
import { workflowDefinition } from "@intx/db/schema";
import type { AssetService } from "@intx/hub-sessions";

import { readPinnedSkillNames, reindexPinnedSkills } from "./agent-workflow";
import { commitLatestAgentAssetSnapshot } from "./asset-write";
import {
  RetiredWorkflowEnvelopeError,
  statusForAgentDefinitionDeployError,
  writeAndDeployAgentDefinition,
  WorkflowAuthorError,
  type AgentDefinitionDeployer,
} from "./definition-asset";
import type { PinnedSkillIndexResolver } from "./routes";
import { makeErrorEnvelope } from "@corbits/error-sink";
import type {
  WorkflowCapabilityRunScope,
  WorkflowRunAuthenticator as WorkflowCapabilityRunAuthenticator,
} from "./workflow-capability-routes";

/** The same run scope `workflow-capability-routes.ts` resolves, reused by
 * type alias since both live in this package. */
export type WorkflowSkillPinRunScope = WorkflowCapabilityRunScope;
export type WorkflowRunAuthenticator = WorkflowCapabilityRunAuthenticator;

export type WorkflowSkillPinEnv = {
  Variables: { workflowSkillPinScope: WorkflowSkillPinRunScope };
};

function definitionNotFound(definitionId: string) {
  return makeErrorEnvelope({
    code: "not_found",
    userMessage: `No agent definition "${definitionId}" in this workbench`,
  });
}

/** Same host-guard as `./routes.ts`, duplicated since
 * `workflow-capability-routes.ts` doesn't export its own copy. */
function hostGuardedRow(
  row: { readonly name: string; readonly assetId: string | null } | undefined,
): row is { readonly name: string; readonly assetId: string } {
  return row !== undefined && row.assetId !== null;
}

const PinBody = type({
  definitionId: "string > 0",
  skillName: "string > 0",
});

export type CreateWorkflowSkillPinRoutesDeps = {
  db: DB["db"];
  assetService: AssetService;
  skillIndex: PinnedSkillIndexResolver;
  authenticator: WorkflowRunAuthenticator;
  /** Deploys the definition's commit through the native source pipeline
   * after the rewrite. */
  deployer: AgentDefinitionDeployer;
};

export function createWorkflowSkillPinRoutes(
  deps: CreateWorkflowSkillPinRoutesDeps,
): Hono<WorkflowSkillPinEnv> {
  const app = new Hono<WorkflowSkillPinEnv>();

  // A definition whose asset predates the source-form cutover cannot be
  // read or re-pinned until it is re-authored — a client-visible
  // conflict, never a server fault.
  app.onError((err, c) => {
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
    c.set("workflowSkillPinScope", scope);
    await next();
  });

  app.post("/pin", async (c) => {
    const scope = c.get("workflowSkillPinScope");
    const body = PinBody(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: `invalid pin: ${body.summary}`,
        }),
        400,
      );
    }

    const row = await deps.db.query.workflowDefinition.findFirst({
      where: and(
        eq(workflowDefinition.id, body.definitionId),
        eq(workflowDefinition.tenantId, scope.tenantId),
      ),
    });
    if (!hostGuardedRow(row)) {
      return c.json(definitionNotFound(body.definitionId), 404);
    }

    const next = await commitLatestAgentAssetSnapshot({
      assetService: deps.assetService,
      assetId: row.assetId,
      operation: "pin skill",
      prepare: async (snapshot) => {
        // Pins read out of the commit being prepared: the asset's
        // stanza is the source of truth, so a concurrent writer's pins
        // survive the retry instead of being clobbered by a stale read.
        const skills = readPinnedSkillNames(snapshot);
        const nextSkills = skills.includes(body.skillName) ? skills : [...skills, body.skillName];
        return {
          workflowJson: reindexPinnedSkills(
            snapshot,
            await deps.skillIndex.resolve(scope.tenantId, scope.principalId, nextSkills),
          ),
          message: `Pin ${body.skillName} skill to ${row.name}`,
          result: { skills: nextSkills },
        };
      },
      write: async ({ workflowJson, message }) => {
        await writeAndDeployAgentDefinition({
          assetService: deps.assetService,
          deployer: deps.deployer,
          tenantId: scope.tenantId,
          principalId: scope.principalId,
          assetId: row.assetId,
          handle: row.name,
          workflowJson,
          message,
        });
      },
    });

    return c.json(next);
  });

  return app;
}
