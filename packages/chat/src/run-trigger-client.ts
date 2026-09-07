// A thin client over Interchange's own workflow-run mail-trigger route
// (`POST /api/tenants/:tenantId/workflows/runs/:runId/mail`, mounted by
// `vendor/intx/hub-api`'s `createRunRoutes`). CL-7490: a provisioned
// run's first `agent.deploy` only fires from inside that route's
// durable-dispatch branch (`createWorkflowRunTrigger` in
// `vendor/intx/hub-api/src/workflow-run-trigger.ts`) — a raw
// `sessionService.sendUserMessage` never reaches it, so an invited run
// that has never been triggered natively stays undeployed and
// unreachable forever. `createWorkflowRunTrigger` itself is not
// exported from `@intx/hub-api` (it is the route's own private
// dependency, not a published seam), so this calls the mounted HTTP
// route instead of reimplementing what it does.
//
// The call is in-process against the hub's own composed Hono `app` —
// no network hop, no separate origin to configure — authenticated the
// way any other request to that route is: through `@intx/hub-api`'s
// session contract. Chat has no browser cookie to present (most sends
// happen with no inbound HTTP request in scope at all — mention
// fan-out, a relaunch resend, the mailbox-fanout persist seam), so it
// presents a short-lived signed token instead (see
// `./run-trigger-internal-auth.ts`) that `apps/hub`'s own `getSession`
// implementation verifies before falling through to the real
// cookie-session path. Neither side touches `vendor/intx`.
import { type } from "arktype";

import type { MailContent } from "./codec";
import { signInternalRunTriggerToken } from "./run-trigger-internal-auth";

// Mirrors `vendor/intx/hub-api/src/workflow-run-trigger.ts`'s own
// `WorkflowRunTriggerResponse` — not imported directly since
// `@intx/hub-api` does not re-export it from its package entry point.
// Parsed here rather than trusted as `as` cast: this is a trust
// boundary (an HTTP response), even though the call never leaves the
// process.
const TriggerResponse = type({
  runId: "string",
  address: "string",
  messageId: "string",
});

const TriggerErrorBody = type({
  error: {
    code: "string",
    message: "string",
  },
});

export class RunTriggerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`workflow-run trigger failed (${status} ${code}): ${message}`);
    this.name = "RunTriggerError";
  }
}

export type RunTriggerClientDeps = {
  /**
   * The hub's own composed Hono app (`@intx/hub-api`'s `App`, built by
   * `createApp`). Calling `.request()` on it dispatches straight
   * through the route's own middleware chain in-process — the same
   * path a real inbound request to the hub takes.
   */
  app: {
    request: (
      input: string,
      init?: RequestInit,
    ) => Response | Promise<Response>;
  };
  /**
   * The shared secret `./run-trigger-internal-auth.ts` signs the
   * per-call token with. Must be the same value `apps/hub` wires into
   * its `getSession` verifier — the host's composition root, never a
   * package default, owns that pairing.
   */
  internalAuthSecret: string;
  /**
   * Mints the token asserting which better-auth `user.id` this trigger
   * call authenticates as. Separated from `internalAuthSecret` only so
   * a test can supply a fixed clock; production always uses
   * `signInternalRunTriggerToken` from `./run-trigger-internal-auth.ts`.
   */
  signToken?: (secret: string, userId: string) => string;
};

export type TriggerWorkflowRunMailInput = {
  readonly tenantId: string;
  /** The deployment's anchor run id (`:runId` in the route path). */
  readonly anchorRunId: string;
  readonly content: string;
  readonly attachments?: MailContent["attachments"];
  /**
   * The better-auth `user.id` this call authenticates as. The route
   * derives the delivered mail's `From` header from whatever principal
   * this resolves to in the target tenant, so this should be the real
   * sending human when one exists (`sendMail`'s own `principalId`),
   * and the workflow definition asset's `creatorPrincipalId` (resolved
   * to its owning user) otherwise — see the callers in
   * `./platform-adapter.ts`.
   */
  readonly authAsUserId: string;
};

export type TriggeredWorkflowRunMail = {
  readonly runId: string;
  readonly address: string;
  readonly messageId: string;
};

export type RunTriggerClient = {
  triggerMail(
    input: TriggerWorkflowRunMailInput,
  ): Promise<TriggeredWorkflowRunMail>;
};

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    // report-error-ignore: a response body that fails to parse as JSON
    // is handled by the caller's own arktype parse — `TriggerErrorBody`
    // or `TriggerResponse` rejecting `null` — which throws a real,
    // reported error naming the malformed response; this local catch
    // only stops a parse failure itself from masking that path.
    return null;
  }
}

export function createRunTriggerClient(
  deps: RunTriggerClientDeps,
): RunTriggerClient {
  return {
    async triggerMail(input): Promise<TriggeredWorkflowRunMail> {
      const signToken = deps.signToken ?? signInternalRunTriggerToken;
      const token = signToken(deps.internalAuthSecret, input.authAsUserId);
      const body: {
        content: string;
        attachments?: MailContent["attachments"];
      } =
        input.attachments !== undefined
          ? { content: input.content, attachments: input.attachments }
          : { content: input.content };

      const response = await deps.app.request(
        `/api/tenants/${input.tenantId}/workflows/runs/${input.anchorRunId}/mail`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-corbits-internal-run-trigger": token,
          },
          body: JSON.stringify(body),
        },
      );

      const json = await readJson(response);
      if (response.status !== 202) {
        const parsedError = TriggerErrorBody(json);
        const { code, message } =
          parsedError instanceof type.errors
            ? { code: "unknown", message: response.statusText }
            : parsedError.error;
        throw new RunTriggerError(response.status, code, message);
      }

      const parsed = TriggerResponse(json);
      if (parsed instanceof type.errors) {
        throw new Error(
          `malformed workflow-run trigger response: ${parsed.summary}`,
        );
      }
      return parsed;
    },
  };
}
