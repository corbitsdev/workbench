// The HTTP surface of `@corbits/task-planner`: one route, mirroring
// `@corbits/tasks`' `createTaskRoutes` exactly — tenant-scoped,
// `requireGrant`-gated, personal to the requesting principal (a
// planning prompt is a person's own, like a task prompt), request
// parsing via arktype at the boundary, route registration only. Error
// copy at this boundary is plain language for the person who typed the
// outcome; the technical detail every fail-closed error class carries
// goes to the server log instead.
import { type } from "arktype";
import { Hono } from "hono";

import type { TenantEnv, RequireGrant } from "@intx/hub-api";
import { getLogger } from "@intx/log";

import {
  PlannerInferenceUnavailableError,
  PlannerMyraUnavailableError,
} from "./planner-run";
import {
  FoldedRunFailedError,
  FoldedRunTimedOutError,
} from "@corbits/folded-runs";
import {
  PlannerReferenceOutOfInventoryError,
  PlannerReplyUnparseableError,
} from "./task-spec";
import {
  PlannerCreateBoundsViolationError,
  PlannerCredentialBindingUnavailableError,
  PlannerDefinitionGrantDeniedError,
} from "./spawn";
import { SkillRegistryError } from "@corbits/skills";
import type { TaskRecord } from "@corbits/tasks";
import type { PlannerInventory } from "./inventory";
import {
  AgentDefinitionDraftReferenceOutOfInventoryError,
  AgentDefinitionDraftReplyUnparseableError,
  MyraAgentDefinitionDraftingUnavailableError,
  type AgentDefinitionDraft,
} from "./agent-definition-drafting";

const log = getLogger(["task-planner", "routes"]);

/** The shape `dispatchWithPlanner` (`./index.ts`) resolves with —
 * defined here, not in `./index.ts`, so this module and `./index.ts`
 * can reference the same type without an import cycle (`./index.ts`
 * re-exports `createPlannerRoutes` from this module). */
export type DispatchWithPlannerResult = {
  readonly task: TaskRecord;
  readonly plannerRunId: string;
  readonly inventory: PlannerInventory;
};

const ErrorEnvelope = (code: string, message: string) => ({
  error: { code, message },
});

const PLAN_FAILED_MESSAGE =
  "Myra couldn't turn that into a task. Try rephrasing, or pick an agent yourself.";

const INFERENCE_UNAVAILABLE_MESSAGE =
  "The model couldn't be reached — try again in a moment";

const CreatePlanBody = type({
  outcome: "string > 0",
});

const DRAFT_FAILED_MESSAGE =
  "Myra couldn't draft a starting prompt for that. Write one yourself, or try again.";

const CreateAgentDefinitionDraftBody = type({
  name: "string > 0",
  "purpose?": "string > 0",
});

export type CreatePlannerRoutesDeps = {
  requireGrant: RequireGrant;
  /**
   * The dispatch port, mirroring `@corbits/tasks`' routes-depend-on-
   * platform-port shape: the route never calls `dispatchWithPlanner`
   * (or anything in `./planner-run.ts`/`./spawn.ts`) directly, so this
   * module is testable with a plain stub — no database, no folded-run
   * machinery.
   */
  dispatch(input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly outcome: string;
  }): Promise<DispatchWithPlannerResult>;
  /**
   * The agent-definition drafting port (CL-6074) — omitted entirely on
   * a host that hasn't wired Myra drafting up yet, in which case this
   * route 404s rather than pretending to draft and always failing.
   * Mirrors `dispatch`'s stub-testable shape: the route never touches
   * `./agent-definition-drafting.ts`'s runner/inventory machinery
   * directly.
   */
  draftAgentDefinition?(input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly name: string;
    readonly purpose?: string;
  }): Promise<AgentDefinitionDraft>;
};

/** Every fail-closed error the agent-definition drafting path can throw
 * — Myra unresolvable, the run timing out or failing, an unparseable
 * reply, or an out-of-inventory model/tool package/skill reference —
 * reads as the same honest "couldn't draft" 422 to the person who typed
 * the description: from their point of view it is still "Myra's draft
 * didn't work out," never a REST-shaped bad request they authored
 * themselves. */
function isDraftingFailure(err: unknown): boolean {
  return (
    err instanceof MyraAgentDefinitionDraftingUnavailableError ||
    err instanceof FoldedRunTimedOutError ||
    err instanceof FoldedRunFailedError ||
    err instanceof AgentDefinitionDraftReplyUnparseableError ||
    err instanceof AgentDefinitionDraftReferenceOutOfInventoryError
  );
}

/** Every fail-closed error this package's planning path can throw —
 * Myra unresolvable, the run timing out or failing, an unparseable
 * reply, an out-of-inventory reference, a `{create}` plan that
 * violated a create-agent bound, a denied `workflow-definition:*`
 * `create` grant, an unresolvable skill pin, or a tool pin with no
 * working credential — reads as the same honest "couldn't plan" 422
 * to the person who typed the outcome: from their point of view it is
 * still "Myra's plan didn't work out," never a REST-shaped bad request
 * they authored themselves. Anything else (a `launchTask` error from
 * the dispatch's spawn half, an unexpected throw) is a platform fault,
 * not a planning failure, and is re-thrown for the host's own error
 * handling to surface. */
function isPlanningFailure(err: unknown): boolean {
  return (
    err instanceof PlannerMyraUnavailableError ||
    err instanceof FoldedRunTimedOutError ||
    err instanceof FoldedRunFailedError ||
    err instanceof PlannerReplyUnparseableError ||
    err instanceof PlannerReferenceOutOfInventoryError ||
    err instanceof PlannerCreateBoundsViolationError ||
    err instanceof PlannerCredentialBindingUnavailableError ||
    err instanceof PlannerDefinitionGrantDeniedError ||
    err instanceof SkillRegistryError
  );
}

export function createPlannerRoutes(
  deps: CreatePlannerRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  // A person can't have two "Let Myra choose" runs racing at once — a
  // plain-language 409-ish rejection of a same-principal concurrent
  // second request, released in a `finally` once the first settles.
  // This is single-principal-in-flight only; broader per-tenant rate
  // limiting is tracked separately as CL-5285. In-memory only: a
  // process restart or a second replica resets/bypasses this guard.
  const inFlightPrincipals = new Set<string>();

  app.post("/", deps.requireGrant("task:*", "create"), async (c) => {
    const body = CreatePlanBody(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) {
      return c.json(
        ErrorEnvelope(
          "bad_request",
          `This outcome couldn't be read: ${body.summary}`,
        ),
        400,
      );
    }

    const tenant = c.get("tenant");
    const principal = c.get("principal");

    if (inFlightPrincipals.has(principal.id)) {
      return c.json(
        ErrorEnvelope(
          "dispatch_in_progress",
          "Myra is already working on your last request.",
        ),
        409,
      );
    }
    inFlightPrincipals.add(principal.id);

    try {
      const result = await deps.dispatch({
        tenantId: tenant.id,
        principalId: principal.id,
        outcome: body.outcome,
      });
      return c.json(
        { task: result.task, plannerRunId: result.plannerRunId },
        201,
      );
    } catch (err) {
      log.error`planner dispatch failed for tenant ${tenant.id}: ${
        err instanceof Error ? err.message : String(err)
      }`;
      if (err instanceof PlannerInferenceUnavailableError) {
        return c.json(
          ErrorEnvelope("inference_unavailable", INFERENCE_UNAVAILABLE_MESSAGE),
          503,
        );
      }
      if (isPlanningFailure(err)) {
        return c.json(
          ErrorEnvelope("planning_failed", PLAN_FAILED_MESSAGE),
          422,
        );
      }
      throw err;
    } finally {
      inFlightPrincipals.delete(principal.id);
    }
  });

  // A separate in-flight set from `inFlightPrincipals` above — drafting
  // an agent and letting Myra choose a task are independent actions a
  // principal could otherwise race against each other; each gets its
  // own single-in-flight guard, released in a `finally` once the draft
  // settles.
  const inFlightDraftingPrincipals = new Set<string>();

  if (deps.draftAgentDefinition !== undefined) {
    const draftAgentDefinition = deps.draftAgentDefinition;
    app.post(
      "/agent-definitions/draft",
      deps.requireGrant("workflow-definition:*", "create"),
      async (c) => {
        const body = CreateAgentDefinitionDraftBody(
          await c.req.json().catch(() => undefined),
        );
        if (body instanceof type.errors) {
          return c.json(
            ErrorEnvelope(
              "bad_request",
              `This couldn't be read: ${body.summary}`,
            ),
            400,
          );
        }

        const tenant = c.get("tenant");
        const principal = c.get("principal");

        if (inFlightDraftingPrincipals.has(principal.id)) {
          return c.json(
            ErrorEnvelope(
              "dispatch_in_progress",
              "Myra is already drafting your last agent.",
            ),
            409,
          );
        }
        inFlightDraftingPrincipals.add(principal.id);

        try {
          const draft = await draftAgentDefinition({
            tenantId: tenant.id,
            principalId: principal.id,
            name: body.name,
            ...(body.purpose !== undefined ? { purpose: body.purpose } : {}),
          });
          return c.json({ draft }, 201);
        } catch (err) {
          log.error`agent definition drafting failed for tenant ${tenant.id}: ${
            err instanceof Error ? err.message : String(err)
          }`;
          if (isDraftingFailure(err)) {
            return c.json(
              ErrorEnvelope("drafting_failed", DRAFT_FAILED_MESSAGE),
              422,
            );
          }
          throw err;
        } finally {
          inFlightDraftingPrincipals.delete(principal.id);
        }
      },
    );
  }

  return app;
}
