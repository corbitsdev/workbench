// The `@corbits/access-tools` bundle: `list_principals` and
// `list_grants` (plain reads, no approval) plus `grant_access` and
// `revoke_access` (`approval: "ask"` — `@intx/agent`'s native
// per-invocation gate suspends the call as a pending approval BEFORE
// this bundle's `run` ever executes, exactly like
// `@corbits/capability-tools`'s `request_capability`). Lets Myra create
// scoped grants for the specialist agents she stands up, gated behind a
// human approving each grant.
//
// `hubAccessUrl`/`sidecarToken`/`address` are threaded onto `env` by the
// sidecar's per-step env builder, the same ground every other manager-
// tools bundle's own env keys are threaded from.
//
// See `./client.ts` for the workflow-run-authenticated routes this
// bundle's execution calls, and `./routes.ts` for their hub-side
// implementation.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { type } from "arktype";
import { reportError } from "@corbits/error-sink";

import {
  grantAccess,
  listGrants,
  listPrincipals,
  revokeAccess,
  type AccessToolClientConfig,
} from "./client";

export const LIST_PRINCIPALS_TOOL = "list_principals";
export const LIST_GRANTS_TOOL = "list_grants";
export const GRANT_ACCESS_TOOL = "grant_access";
export const REVOKE_ACCESS_TOOL = "revoke_access";

export interface WorkflowAccessEnv extends BaseEnv {
  readonly hubAccessUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
}

const ListGrantsInput = type({
  "principalId?": "string > 0",
  "resource?": "string > 0",
});

const GrantAccessInput = type({
  principalId: "string > 0",
  resource: "string > 0",
  actions: type("string > 0").array().atLeastLength(1),
  "why?": "string > 0",
});

const RevokeAccessInput = type({
  grantId: "string > 0",
});

function errorResult(callId: string, err: unknown): ToolResult {
  return {
    callId,
    isError: true,
    content: err instanceof Error ? err.message : String(err),
  };
}

function clientConfig(env: WorkflowAccessEnv): AccessToolClientConfig {
  return {
    hubAccessUrl: env.hubAccessUrl,
    sidecarToken: env.sidecarToken,
    address: env.address,
  };
}

async function runListPrincipals(
  env: WorkflowAccessEnv,
  call: ToolCall,
): Promise<ToolResult> {
  try {
    const principals = await listPrincipals(clientConfig(env));
    const content =
      principals.length === 0
        ? "No principals in this tenant."
        : principals
            .map((p) => `${p.kind} ${p.refId} — ${p.status} (id: ${p.id})`)
            .join("\n");
    return { callId: call.id, isError: false, content };
  } catch (err) {
    reportError(err, {
      operation: "list_principals",
      agentId: env.address,
    });
    return errorResult(call.id, err);
  }
}

async function runListGrants(
  env: WorkflowAccessEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const parsed = ListGrantsInput(call.arguments);
  if (parsed instanceof type.errors) {
    return errorResult(
      call.id,
      new Error(`list_grants received invalid input: ${parsed.summary}`),
    );
  }
  try {
    const grants = await listGrants(clientConfig(env), {
      ...(parsed.principalId !== undefined
        ? { principalId: parsed.principalId }
        : {}),
      ...(parsed.resource !== undefined ? { resource: parsed.resource } : {}),
    });
    const content =
      grants.length === 0
        ? "No matching grants."
        : grants
            .map(
              (g) =>
                `${g.effect} ${g.resource}:${g.action} -> principal ${g.principalId ?? "(role)"} (id: ${g.id})`,
            )
            .join("\n");
    return { callId: call.id, isError: false, content };
  } catch (err) {
    reportError(err, { operation: "list_grants", agentId: env.address });
    return errorResult(call.id, err);
  }
}

async function runGrantAccess(
  env: WorkflowAccessEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const parsed = GrantAccessInput(call.arguments);
  if (parsed instanceof type.errors) {
    return errorResult(
      call.id,
      new Error(`grant_access received invalid input: ${parsed.summary}`),
    );
  }
  try {
    const grants = await grantAccess(clientConfig(env), {
      principalId: parsed.principalId,
      resource: parsed.resource,
      actions: parsed.actions,
    });
    return {
      callId: call.id,
      isError: false,
      content: `Granted ${parsed.actions.join(", ")} on ${parsed.resource} to ${parsed.principalId} (${grants.length} grant${grants.length === 1 ? "" : "s"} created).`,
    };
  } catch (err) {
    reportError(err, { operation: "grant_access", agentId: env.address });
    return errorResult(call.id, err);
  }
}

async function runRevokeAccess(
  env: WorkflowAccessEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const parsed = RevokeAccessInput(call.arguments);
  if (parsed instanceof type.errors) {
    return errorResult(
      call.id,
      new Error(`revoke_access received invalid input: ${parsed.summary}`),
    );
  }
  try {
    await revokeAccess(clientConfig(env), parsed.grantId);
    return {
      callId: call.id,
      isError: false,
      content: `Revoked grant ${parsed.grantId}.`,
    };
  } catch (err) {
    reportError(err, { operation: "revoke_access", agentId: env.address });
    return errorResult(call.id, err);
  }
}

/**
 * The `@corbits/access-tools` bundle factory: `list_principals` and
 * `list_grants` (read, no approval), `grant_access` and `revoke_access`
 * (`approval: "ask"`) — Myra's own way to create principals-scoped
 * grants for the agents she stands up.
 */
export const accessTools = defineTool<WorkflowAccessEnv>({
  id: "@corbits/access-tools/access",
  requires: ["hubAccessUrl", "sidecarToken", "address"],
  definitions: [
    { name: LIST_PRINCIPALS_TOOL },
    { name: LIST_GRANTS_TOOL },
    { name: GRANT_ACCESS_TOOL, approval: "ask" },
    { name: REVOKE_ACCESS_TOOL, approval: "ask" },
  ],
  factory: (env) => ({
    definitions: [
      {
        name: LIST_PRINCIPALS_TOOL,
        description:
          "List the principals (users, agents, and workflow runs) in " +
          "this tenant, with their id, kind, and status — use this to " +
          "find the principal id a grant should target.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: LIST_GRANTS_TOOL,
        description:
          "List grants in this tenant, optionally filtered by " +
          "principalId or resource — use this to see what a principal " +
          "already has before granting more, or to find the grant id " +
          "revoke_access needs.",
        inputSchema: {
          type: "object",
          properties: {
            principalId: {
              type: "string",
              description: "Only grants targeting this principal id.",
            },
            resource: {
              type: "string",
              description:
                'Only grants for this exact resource string (e.g. "workflow-run:*").',
            },
          },
        },
      },
      {
        name: GRANT_ACCESS_TOOL,
        description:
          "grant a principal one or more scoped actions on a resource " +
          "-- e.g. letting a specialist agent read its own workflow " +
          "runs. A human must approve before anything is granted. Use " +
          "this only for a genuine, specific need; never speculatively, " +
          "and never grant broader access than the specific need " +
          "requires.",
        inputSchema: {
          type: "object",
          properties: {
            principalId: {
              type: "string",
              description:
                "The principal id to grant access to (from list_principals).",
            },
            resource: {
              type: "string",
              description:
                'The resource string to grant, e.g. "workflow-run:*" or ' +
                '"asset:ast_123".',
            },
            actions: {
              type: "array",
              items: { type: "string" },
              description:
                'Actions to grant on that resource, e.g. ["read"] or ' +
                '["read", "write"].',
            },
            why: {
              type: "string",
              description:
                "One sentence on why this grant is needed right now, " +
                "shown to the person approving the request.",
            },
          },
          required: ["principalId", "resource", "actions"],
        },
      },
      {
        name: REVOKE_ACCESS_TOOL,
        description:
          "Revoke a previously created grant by its id (from " +
          "list_grants). A human must approve before anything is " +
          "revoked.",
        inputSchema: {
          type: "object",
          properties: {
            grantId: {
              type: "string",
              description: "The grant id to revoke.",
            },
          },
          required: ["grantId"],
        },
      },
    ],
    run: (call: ToolCall, _signal: AbortSignal) => {
      switch (call.name) {
        case LIST_PRINCIPALS_TOOL:
          return runListPrincipals(env, call);
        case LIST_GRANTS_TOOL:
          return runListGrants(env, call);
        case GRANT_ACCESS_TOOL:
          return runGrantAccess(env, call);
        case REVOKE_ACCESS_TOOL:
          return runRevokeAccess(env, call);
        default:
          return Promise.resolve(
            errorResult(
              call.id,
              new Error(`@corbits/access-tools: unknown tool "${call.name}"`),
            ),
          );
      }
    },
  }),
});
