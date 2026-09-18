// The sanctioned path for a workflow-process child to create a new agent
// definition and list the tenant's taskable agents, authenticated through
// `WorkflowRunAuthenticator` since a workflow child has no browser session.
// Mounted outside the tenant prefix; identity never rides in the body or
// path. Scoped to the caller's own tenant rather than "own definition
// only" — there's no existing row to scope against for a create.
//
// No `requireGrant` check: the calling tool declares `approval: "ask"`, so
// a human already approved the specific agent being created before this
// route runs. This route still enforces the sidecar-token/run-address
// check and fails closed on any named `toolPackagePins`.
import { type } from "arktype";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

import type { DB } from "@intx/db";
import { tenant, workflowDefinition } from "@intx/db/schema";
import type { AssetService } from "@intx/hub-sessions";

import { skillNameSchema } from "@corbits/skills-tools";
import { isAutomatableWorkflowName } from "@corbits/workflows/catalog";

import {
  createAgentDefinitionCore,
  DuplicateAgentHandleError,
  type CreateAgentDefinitionCoreDeps,
  type CreateAgentDefinitionCoreInput,
} from "./agent-workflow";
import {
  assertCapabilityInInventory,
  baselineAgentToolPins,
  CapabilityOutOfInventoryError,
  type CapabilityInventoryProvider,
} from "./capability-inventory";
import { makeErrorEnvelope } from "@corbits/error-sink";
import type {
  WorkflowCapabilityRunScope,
  WorkflowRunAuthenticator,
} from "./workflow-capability-routes";

export type WorkflowAgentCreateEnv = {
  Variables: { workflowCapabilityScope: WorkflowCapabilityRunScope };
};

// Mirrors `./validation.ts`'s `HANDLE_PATTERN` exactly.
const HANDLE_PATTERN = type(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const CreateWorkflowAgentDefinitionInput = type({
  name: "string > 0",
  handle: HANDLE_PATTERN,
  systemPrompt: "string > 0",
  "model?": "string > 0",
  "skills?": skillNameSchema.array(),
  "toolPackagePins?": type("string > 0").array(),
});

/** A definition this listing offers as a taskable conversational agent.
 * Replicated here rather than imported, since importing `apps/hub`'s
 * listing helper back would invert the dependency. */
function isConversationalAgentDefinition(definition: { readonly name: string }): boolean {
  return !isAutomatableWorkflowName(definition.name);
}

export type CreateWorkflowAgentCreateRoutesDeps = {
  readonly db: DB["db"];
  readonly assetService: AssetService;
  readonly skillIndex: CreateAgentDefinitionCoreDeps["skillIndex"];
  readonly capabilityInventory: CapabilityInventoryProvider;
  readonly authenticator: WorkflowRunAuthenticator;
  readonly deployer: CreateAgentDefinitionCoreDeps["deployer"];
  readonly tenantDefaultModel?: CreateAgentDefinitionCoreDeps["tenantDefaultModel"];
};

export function createWorkflowAgentCreateRoutes(
  deps: CreateWorkflowAgentCreateRoutesDeps,
): Hono<WorkflowAgentCreateEnv> {
  const app = new Hono<WorkflowAgentCreateEnv>();

  app.onError((err, c) => {
    if (err instanceof CapabilityOutOfInventoryError) {
      return c.json(makeErrorEnvelope({ code: "bad_request", userMessage: err.message }), 400);
    }
    if (err instanceof DuplicateAgentHandleError) {
      return c.json(makeErrorEnvelope({ code: "conflict", userMessage: err.message }), 409);
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

  app.post("/definitions", async (c) => {
    const scope = c.get("workflowCapabilityScope");
    const body = CreateWorkflowAgentDefinitionInput(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: `invalid agent definition: ${body.summary}`,
        }),
        400,
      );
    }

    // Resolved once: also the source of truth for `model` validation below.
    const inventory = await deps.capabilityInventory.resolve({
      tenantId: scope.tenantId,
      principalId: scope.principalId,
    });

    if (body.toolPackagePins !== undefined && body.toolPackagePins.length > 0) {
      // Throws `CapabilityOutOfInventoryError`, caught by `app.onError`.
      for (const name of body.toolPackagePins) {
        assertCapabilityInInventory({ kind: "toolPackage", name }, inventory);
      }
    }

    const tenantRow = await deps.db.query.tenant.findFirst({
      where: eq(tenant.id, scope.tenantId),
    });
    if (tenantRow === undefined) {
      throw new Error(`No tenant "${scope.tenantId}"`);
    }

    const skills = body.skills ?? [];
    // Mutably built: `exactOptionalPropertyTypes` needs an absent
    // `model`/`toolPackagePins` to be an absent key.
    const coreInput: {
      -readonly [K in keyof CreateAgentDefinitionCoreInput]: CreateAgentDefinitionCoreInput[K];
    } = {
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      tenantDomain: tenantRow.domain,
      handle: body.handle,
      name: body.name,
      systemPrompt: body.systemPrompt,
      skills,
    };

    // `body.model` is untrusted tool-call input. A name outside the
    // catalog falls back to the tenant default and says so, rather than
    // creating a dead agent.
    let modelNote: string | null = null;
    if (body.model !== undefined) {
      const knownModel = inventory.models.some((entry) => entry.canonicalName === body.model);
      if (knownModel) {
        coreInput.model = body.model;
      } else {
        const fallback = await deps.tenantDefaultModel?.(scope.tenantId);
        modelNote =
          fallback !== undefined
            ? `Requested model "${body.model}" is not in this workbench's catalog; used the workspace default "${fallback}" instead.`
            : `Requested model "${body.model}" is not in this workbench's catalog, and the workspace has no default model to fall back to.`;
        if (fallback !== undefined) coreInput.model = fallback;
      }
    }

    if (body.toolPackagePins !== undefined && body.toolPackagePins.length > 0) {
      coreInput.toolPackagePins = body.toolPackagePins;
    } else {
      // No pins named: still gets the baseline set this tenant can resolve.
      const baseline = baselineAgentToolPins(inventory);
      if (baseline.length > 0) coreInput.toolPackagePins = baseline;
    }

    const { row } = await createAgentDefinitionCore(
      {
        db: deps.db,
        assetService: deps.assetService,
        skillIndex: deps.skillIndex,
        deployer: deps.deployer,
        ...(deps.tenantDefaultModel !== undefined
          ? { tenantDefaultModel: deps.tenantDefaultModel }
          : {}),
      },
      coreInput,
    );

    return c.json(
      {
        id: row.id,
        name: row.name,
        description: row.description ?? null,
        currentVersion: row.currentVersion,
        status: row.status,
        skills,
        modelNote,
      },
      201,
    );
  });

  app.get("/definitions", async (c) => {
    const scope = c.get("workflowCapabilityScope");
    const rows = await deps.db.query.workflowDefinition.findMany({
      where: and(
        eq(workflowDefinition.tenantId, scope.tenantId),
        eq(workflowDefinition.status, "deployed"),
      ),
    });
    const definitions = rows
      .filter((row) => isConversationalAgentDefinition(row))
      .map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description ?? null,
      }));
    return c.json({ definitions });
  });

  return app;
}
