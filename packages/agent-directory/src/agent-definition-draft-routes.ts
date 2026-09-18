// The HTTP surface for Myra-backed agent-definition drafting: tenant-scoped,
// `requireGrant`-gated, personal to the requesting principal. Error copy is
// plain language for the person who typed the description; technical detail
// goes to the server log instead.
import { type } from "arktype";
import { Hono } from "hono";

import type { TenantEnv, RequireGrant } from "@intx/hub-api";
import {
  OneShotRunFailedError,
  OneShotRunTimedOutError,
  OneShotRunUnreachableError,
} from "./one-shot-prompt";
import { makeErrorEnvelope, reportError } from "@corbits/error-sink";
import {
  AgentDefinitionDraftReferenceOutOfInventoryError,
  AgentDefinitionDraftReplyUnparseableError,
  MyraAgentDefinitionDraftingUnavailableError,
  type AgentDefinitionDraft,
} from "./agent-definition-drafting";

const DRAFT_FAILED_MESSAGE =
  "Myra couldn't draft a starting prompt for that. Write one yourself, or try again.";

const CreateAgentDefinitionDraftBody = type({
  name: "string > 0",
  "purpose?": "string > 0",
});

export type CreateAgentDefinitionDraftRoutesDeps = {
  requireGrant: RequireGrant;
  /** Omitted on a host that hasn't wired Myra drafting up yet, in which
   * case the route answers 503 instead of pretending to draft. */
  draftAgentDefinition?(input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly name: string;
    readonly purpose?: string;
  }): Promise<AgentDefinitionDraft>;
};

/** Every fail-closed error the drafting path can throw reads as the same
 * honest "couldn't draft" 422, never a REST-shaped bad request the person
 * authored themselves. */
function isDraftingFailure(err: unknown): boolean {
  return (
    err instanceof MyraAgentDefinitionDraftingUnavailableError ||
    err instanceof OneShotRunTimedOutError ||
    err instanceof OneShotRunFailedError ||
    err instanceof OneShotRunUnreachableError ||
    err instanceof AgentDefinitionDraftReplyUnparseableError ||
    err instanceof AgentDefinitionDraftReferenceOutOfInventoryError
  );
}

export function createAgentDefinitionDraftRoutes(
  deps: CreateAgentDefinitionDraftRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  // A person can't have two "draft this agent" runs racing at once — a
  // plain-language 409-ish rejection of a same-principal concurrent
  // second request, released in a `finally` once the first settles.
  // In-memory only: a process restart or a second replica resets/
  // bypasses this guard.
  const inFlightDraftingPrincipals = new Set<string>();

  // Always mounted: a host without a drafting port answers an honest 503
  // instead of the route silently not existing (a 404 the client cannot
  // tell apart from a renamed path).
  app.post(
    "/agent-definitions/draft",
    deps.requireGrant("workflow-definition:*", "create"),
    async (c) => {
      const draftAgentDefinition = deps.draftAgentDefinition;
      if (draftAgentDefinition === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "unavailable",
            userMessage: "Agent drafting is not configured on this hub.",
          }),
          503,
        );
      }
      const body = CreateAgentDefinitionDraftBody(await c.req.json().catch(() => undefined));
      if (body instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `This couldn't be read: ${body.summary}`,
          }),
          400,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");

      if (inFlightDraftingPrincipals.has(principal.id)) {
        return c.json(
          makeErrorEnvelope({
            code: "dispatch_in_progress",
            userMessage: "Myra is already drafting your last agent.",
          }),
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
        if (isDraftingFailure(err)) {
          const refId = reportError(err, {
            operation: "agentDirectory.draftAgentDefinition",
            tenantId: tenant.id,
            extra: { principalId: principal.id },
          });
          return c.json(
            makeErrorEnvelope({
              code: "drafting_failed",
              userMessage: DRAFT_FAILED_MESSAGE,
              refId,
            }),
            422,
          );
        }
        throw err;
      } finally {
        inFlightDraftingPrincipals.delete(principal.id);
      }
    },
  );

  return app;
}
