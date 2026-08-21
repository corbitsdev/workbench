// The sanctioned path for a workflow-process child to create a NEW
// agent definition in its own tenant and list the tenant's taskable
// agents — the execution half of `@corbits/agent-directory-tools`'
// `create_agent`/`list_agents` (Myra's manager tools), mirroring
// `./workflow-capability-routes.ts`: a workflow child has no browser
// session, only its sidecar bearer token and its own run address, so
// it authenticates through a `WorkflowRunAuthenticator` rather than the
// tenant-session pipeline `./routes.ts` uses.
//
// Mounted OUTSIDE the tenant prefix for that reason. Identity NEVER
// rides in a request body or path: the tenant and principal every
// write is scoped to come from the authenticated run alone.
//
// Scope, deliberately different from `./workflow-capability-routes.ts`'s
// "own definition only" rule: creating a definition has no existing
// row to scope self-ness against, so this surface is scoped to the
// caller's own TENANT instead — a run may create any number of new
// definitions in its own tenant, never in another.
//
// Authorization decision (same shape as `./workflow-capability-routes.ts`'s,
// see that file's own comment for the full reasoning this mirrors):
// this route carries no `requireGrant` check. The calling tool
// (`@corbits/agent-directory-tools`' `create_agent`) declares
// `approval: "ask"` (`@intx/agent`'s native per-invocation gate), so
// the reactor suspends the call as a pending approval and renders it
// in-chat BEFORE this route ever runs — a human already had to approve
// the specific agent being created. This route still enforces,
// unconditionally: (1) the caller's run must resolve to a live
// tenant/principal/run via the sidecar-token + run-address check
// below, and (2) any `toolPackagePins` named in the create body must
// fail closed against the tenant's live capability inventory
// (`assertCapabilityInInventory`, unchanged from the tenant-session
// route's own guided-capability-add check).
import { type } from "arktype";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

import type { DB } from "@intx/db";
import { tenant, workflowDefinition } from "@intx/db/schema";
import type { AssetService } from "@intx/hub-sessions";

import { skillNameSchema } from "@corbits/skills";
import { isWorkbenchHostDefinitionName } from "@corbits/chat/workbench-host-naming";
import { isAutomatableWorkflowName } from "@corbits/workflow-catalog";

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
import type {
  WorkflowCapabilityRunScope,
  WorkflowRunAuthenticator,
} from "./workflow-capability-routes";

function errorEnvelope(code: string, message: string) {
  return { error: { code, message } };
}

export type WorkflowAgentCreateEnv = {
  Variables: { workflowCapabilityScope: WorkflowCapabilityRunScope };
};

// Mirrors `./validation.ts`'s `HANDLE_PATTERN` exactly — this route's
// handle is bound by the same lowercase-kebab rule the asset service
// enforces at creation, same as the tenant-session route's own field.
const HANDLE_PATTERN = type(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const CreateWorkflowAgentDefinitionInput = type({
  name: "string > 0",
  handle: HANDLE_PATTERN,
  systemPrompt: "string > 0",
  "model?": "string > 0",
  "skills?": skillNameSchema.array(),
  "toolPackagePins?": type("string > 0").array(),
});

/**
 * A definition this listing offers as a taskable/pickable conversational
 * agent for Myra to know about — the same shape `apps/hub`'s
 * `listMyraConversationalAgents` builds, replicated here directly
 * against `workflowDefinition` rather than imported: `apps/hub` is the
 * composition root and depends on this package, so importing its
 * listing helper back would invert that dependency. Deployed, not an
 * automatable catalog workflow, and not a workbench host's own silent
 * anchor definition.
 */
function isConversationalAgentDefinition(definition: {
  readonly name: string;
}): boolean {
  return (
    !isAutomatableWorkflowName(definition.name) &&
    !isWorkbenchHostDefinitionName(definition.name)
  );
}

export type CreateWorkflowAgentCreateRoutesDeps = {
  readonly db: DB["db"];
  readonly assetService: AssetService;
  readonly skillIndex: CreateAgentDefinitionCoreDeps["skillIndex"];
  readonly skillsStore: CreateAgentDefinitionCoreDeps["skillsStore"];
  readonly capabilityInventory: CapabilityInventoryProvider;
  readonly authenticator: WorkflowRunAuthenticator;
  readonly definitionFreezer: CreateAgentDefinitionCoreDeps["definitionFreezer"];
  readonly tenantDefaultModel?: CreateAgentDefinitionCoreDeps["tenantDefaultModel"];
};

export function createWorkflowAgentCreateRoutes(
  deps: CreateWorkflowAgentCreateRoutesDeps,
): Hono<WorkflowAgentCreateEnv> {
  const app = new Hono<WorkflowAgentCreateEnv>();

  app.onError((err, c) => {
    if (err instanceof CapabilityOutOfInventoryError) {
      return c.json(errorEnvelope("bad_request", err.message), 400);
    }
    if (err instanceof DuplicateAgentHandleError) {
      return c.json(errorEnvelope("conflict", err.message), 409);
    }
    throw err;
  });

  app.use("*", async (c, next) => {
    const authHeader = c.req.header("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : "";
    const address = c.req.header("x-workflow-run-address") ?? "";
    const scope = await deps.authenticator.resolve(token, address);
    if (scope === null) {
      return c.json(
        errorEnvelope(
          "unauthorized",
          "Missing or unrecognized sidecar bearer token / run address",
        ),
        401,
      );
    }
    c.set("workflowCapabilityScope", scope);
    await next();
  });

  app.post("/definitions", async (c) => {
    const scope = c.get("workflowCapabilityScope");
    const body = CreateWorkflowAgentDefinitionInput(
      await c.req.json().catch(() => undefined),
    );
    if (body instanceof type.errors) {
      return c.json(
        errorEnvelope(
          "bad_request",
          `invalid agent definition: ${body.summary}`,
        ),
        400,
      );
    }

    // Resolved once, unconditionally: every branch below already needed
    // it (the pin check when pins are named, the baseline lookup when
    // they aren't), and it is now also the source of truth for `model`
    // validation just below.
    const inventory = await deps.capabilityInventory.resolve({
      tenantId: scope.tenantId,
      principalId: scope.principalId,
    });

    if (body.toolPackagePins !== undefined && body.toolPackagePins.length > 0) {
      // Throws `CapabilityOutOfInventoryError`, caught by `app.onError`
      // above — fail closed against exactly the inventory this call
      // just fetched, never a stale or wider one, for every named pin.
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
    // Mutably built for the same `exactOptionalPropertyTypes` reason
    // `./routes.ts`'s `POST /` caller builds its own core input this
    // way: an absent `model`/`toolPackagePins` must be an absent key.
    const coreInput: {
      -readonly [
        K in keyof CreateAgentDefinitionCoreInput
      ]: CreateAgentDefinitionCoreInput[K];
    } = {
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      tenantDomain: tenantRow.domain,
      handle: body.handle,
      name: body.name,
      systemPrompt: body.systemPrompt,
      skills,
    };

    // `body.model` is free text a language-model tool call supplied —
    // untrusted input at a trust boundary (AGENTS.md). A name the
    // tenant's own catalog doesn't offer can never resolve at launch,
    // so it is never baked in verbatim: fall back to the tenant's
    // catalog default and say so, rather than creating a dead agent
    // (CL-6477). A name the catalog does offer is used exactly as
    // asked, no fallback consulted.
    let modelNote: string | null = null;
    if (body.model !== undefined) {
      const knownModel = inventory.models.some(
        (entry) => entry.canonicalName === body.model,
      );
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
      // No pins named: the specialist still gets the baseline set this
      // tenant can resolve, so a created "research agent" can actually
      // search, remember, and ask (CL-6206).
      const baseline = baselineAgentToolPins(inventory);
      if (baseline.length > 0) coreInput.toolPackagePins = baseline;
    }

    const { row } = await createAgentDefinitionCore(
      {
        db: deps.db,
        assetService: deps.assetService,
        skillIndex: deps.skillIndex,
        skillsStore: deps.skillsStore,
        definitionFreezer: deps.definitionFreezer,
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
