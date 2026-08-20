// The sanctioned path for a workflow-process child to invite an
// already-created agent definition into the workbench it is itself
// messaging in — the execution half of `@corbits/agent-directory-tools`'
// `create_agent`'s `invite: true` default (Myra's manager tools):
// after creating a definition through `@corbits/agent-directory`'s
// `createWorkflowAgentCreateRoutes`, the tool calls this surface to
// drop the new agent into the caller's own workbench, reusing
// `./workbench-service.ts`'s `launchAndJoinAgent` directly rather than
// reimplementing invite. Mirrors `@corbits/agent-directory`'s
// `workflow-capability-routes.ts`/`workflow-create-routes.ts`: a
// workflow child has no browser session, only its sidecar bearer token
// and its own run address, so it authenticates through a
// `WorkflowRunAuthenticator` rather than the tenant-session pipeline
// `./routes.ts` uses.
//
// Mounted OUTSIDE the tenant prefix for that reason. Identity NEVER
// rides in a request body or path: the tenant, principal, and target
// workbench every write is scoped to come from the authenticated run
// alone.
//
// Scope: self-WORKBENCH. "The caller's own workbench" is resolved from the
// authenticated run's own mail address via `ChatStore.findWorkbenchByParticipantAddress`
// (see that method's own doc comment in `./store.ts` for the O(workbenches-
// in-tenant) scan it runs and the [Intx/repo gap] it names: no direct
// run-address -> workbench index exists yet). A run whose address is not
// a participant of any workbench in its tenant — a run this route was
// never meant to serve, or called before the run has actually joined
// anything — gets a 404, never a guess at which workbench it meant.
//
// Authorization decision (same shape as `@corbits/agent-directory`'s
// workflow-run routes, see those files' own comments for the full
// reasoning this mirrors): this route carries no `requireGrant` check.
// The calling tool (`@corbits/agent-directory-tools`' `create_agent`)
// declares `approval: "ask"` (`@intx/agent`'s native per-invocation
// gate), so a human already had to approve the specific agent being
// created (and, by extension, invited) before this route ever runs.
// This route still enforces, unconditionally: (1) the caller's run
// must resolve to a live tenant/principal/run via the sidecar-token +
// run-address check below, and (2) the resolved workbench must actually
// carry the caller's own address as a participant — a run can never
// invite into a workbench it is not itself in.
import { Hono } from "hono";
import { type } from "arktype";
import { DefinitionProjectionMissingError } from "@corbits/folded-runs";

import {
  launchAndJoinAgent,
  sendWorkbenchMessage,
  type LaunchAndJoinAgentDeps,
  type SendWorkbenchMessageDeps,
} from "./workbench-service";
import type { ChatStore } from "./store";
import { Part, type Part as PartType } from "./parts";

function errorEnvelope(code: string, message: string) {
  return { error: { code, message } };
}

/**
 * The tenant + principal + run a presented sidecar token and run
 * address resolve to. Declared structurally (mirroring
 * `@corbits/agent-directory`'s `WorkflowCapabilityRunScope`) rather
 * than importing a concrete type from `@corbits/artifacts-hub`, so this
 * package carries no dependency on the artifacts plane; `apps/hub`
 * supplies `@corbits/artifacts-hub`'s `createWorkflowRunAuthenticator`,
 * which satisfies this shape exactly (it resolves a superset: `runId`
 * too).
 */
export type WorkflowParticipantRunScope = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly runId: string;
};

export type WorkflowRunAuthenticator = {
  resolve(
    token: string,
    runAddress: string,
  ): Promise<WorkflowParticipantRunScope | null>;
};

/** The resolved scope PLUS the run's own address — the address is
 * already known once auth succeeds (it is the very header the
 * authenticator checked), and this route needs it again to resolve
 * "the caller's own workbench" below. */
type ResolvedScope = WorkflowParticipantRunScope & { readonly address: string };

export type WorkflowParticipantEnv = {
  Variables: { workflowParticipantScope: ResolvedScope };
};

const InviteParticipantInput = type({ definitionId: "string > 0" });

const PostMessageInput = type({ parts: Part.array() });

export type CreateWorkflowParticipantRoutesDeps = {
  readonly store: Pick<
    ChatStore,
    "findWorkbenchByParticipantAddress" | "updateWorkbenchSettings"
  > &
    SendWorkbenchMessageDeps["store"];
  readonly platform: LaunchAndJoinAgentDeps["platform"] &
    SendWorkbenchMessageDeps["platform"];
  readonly roomMessages: SendWorkbenchMessageDeps["roomMessages"];
  readonly publish: LaunchAndJoinAgentDeps["publish"];
  /** The same one-in-flight-turn-per-workbench queue `createChatRoutes`
   * is given (CL-6331) — shared, never a second instance, so a
   * workflow-child message and a person's own message for the same
   * workbench serialize against each other too. */
  readonly turnQueue: SendWorkbenchMessageDeps["turnQueue"];
  readonly authenticator: WorkflowRunAuthenticator;
};

export function createWorkflowParticipantRoutes(
  deps: CreateWorkflowParticipantRoutesDeps,
): Hono<WorkflowParticipantEnv> {
  const app = new Hono<WorkflowParticipantEnv>();

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
    c.set("workflowParticipantScope", { ...scope, address });
    await next();
  });

  app.post("/participants/invite", async (c) => {
    const scope = c.get("workflowParticipantScope");
    const body = InviteParticipantInput(
      await c.req.json().catch(() => undefined),
    );
    if (body instanceof type.errors) {
      return c.json(
        errorEnvelope("bad_request", `invalid invite body: ${body.summary}`),
        400,
      );
    }

    const workbench = await deps.store.findWorkbenchByParticipantAddress(
      scope.tenantId,
      scope.address,
    );
    if (workbench === undefined) {
      return c.json(
        errorEnvelope(
          "not_found",
          `The calling run "${scope.address}" is not a participant of any workbench in this workbench`,
        ),
        404,
      );
    }

    let joined: Awaited<ReturnType<typeof launchAndJoinAgent>>;
    try {
      joined = await launchAndJoinAgent(
        {
          store: deps.store,
          platform: deps.platform,
          roomMessages: deps.roomMessages,
          publish: deps.publish,
        },
        {
          tenantId: scope.tenantId,
          principalId: scope.principalId,
          workbenchId: workbench.workbenchId,
          definitionId: body.definitionId,
          existingSettings: workbench.settings,
          invitable: await deps.platform.listInvitableDefinitions(
            scope.tenantId,
          ),
        },
      );
    } catch (err) {
      // CL-6357: named, consumer-facing 4xx — never an unhandled 500 —
      // when every asset candidate for the definition has gone
      // unresolvable (DB/blob drift).
      if (err instanceof DefinitionProjectionMissingError) {
        return c.json(errorEnvelope("not_launchable", err.guidance), 409);
      }
      throw err;
    }

    return c.json(
      {
        address: joined.address,
        definitionId: joined.definitionId,
        handle: joined.handle,
      },
      201,
    );
  });

  // The posting half of an in-workbench gen-UI block: a workflow child
  // (`@corbits/interaction-tools`'s `ask_user`) posts a message carrying a
  // `block` part into its own workbench — resolved the same way
  // `/participants/invite` resolves "own workbench", via the caller's mail
  // address. No block-type allowlist here: this route is a generic
  // workbench-message post, same shape `sendWorkbenchMessage` gives any
  // tenant-authenticated caller through `./routes.ts`; the block's own
  // schema (`@corbits/chat`'s `blocks.ts`) is what a renderer trusts, not
  // this route.
  app.post("/participants/messages", async (c) => {
    const scope = c.get("workflowParticipantScope");
    const body = PostMessageInput(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) {
      return c.json(
        errorEnvelope("bad_request", `invalid message body: ${body.summary}`),
        400,
      );
    }

    const workbench = await deps.store.findWorkbenchByParticipantAddress(
      scope.tenantId,
      scope.address,
    );
    if (workbench === undefined) {
      return c.json(
        errorEnvelope(
          "not_found",
          `The calling run "${scope.address}" is not a participant of any workbench in this workbench`,
        ),
        404,
      );
    }

    const sent = await sendWorkbenchMessage(
      {
        store: deps.store,
        platform: deps.platform,
        roomMessages: deps.roomMessages,
        publish: deps.publish,
        turnQueue: deps.turnQueue,
      },
      {
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        senderAddress: scope.address,
        workbenchId: workbench.workbenchId,
        messageParts: body.parts as PartType[],
      },
    );

    return c.json({ id: sent.id, createdAt: sent.createdAt }, 201);
  });

  return app;
}
