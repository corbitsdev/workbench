// The one tool this workflow's step calls: read this tenant's
// credentials through the stock route and report which ones are
// `active` and past their own `expiresAt`. Kept inside the workflow
// package rather than a shared tool package — same "workflow-specific
// logic lives in the definition" convention `exa-topic-watch`'s
// `finalize-tool.ts` established — this read-only reconnect check is
// not a reusable integration on its own.
//
// Read-only: this tool sends no mail and mutates nothing, so it
// declares no `approval` key, matching `list_connections`
// (`@corbits/connections-tools`). The reconnect notice itself is this
// step's own reply text, delivered as mail by the host the same way
// `@corbits/heartbeat-workflow` and `@corbits/workbench-digest-workflow`
// deliver their replies — no separate mail-send tool exists here.
import { defineTool, type BaseEnv } from "@intx/agent";

import { fetchTenantCredentials } from "./client";
import { findDueCredentialExpiries } from "./decide";

export const CREDENTIAL_EXPIRY_CHECK_TOOL_NAME = "credential_expiry_check";

export const CREDENTIAL_EXPIRY_CHECK_DESCRIPTION =
  "Reads this tenant's credentials and reports which ones are active but past their own expiresAt, so a reconnect notice can be drafted for each.";

/** The env this tool needs beyond `BaseEnv`: the run's own hub-reach
 * credential, mirroring `@corbits/connections-tools`'
 * `WorkflowConnectionEnv`. */
export interface WorkflowCredentialExpiryEnv extends BaseEnv {
  readonly hubConnectionsUrl: string;
  readonly tenantId: string;
  readonly sidecarToken: string;
  readonly address: string;
}

export const CREDENTIAL_EXPIRY_CHECK_TOOL = defineTool<WorkflowCredentialExpiryEnv>({
  id: "@corbits/workflow-credential-expiry/check",
  requires: ["hubConnectionsUrl", "tenantId", "sidecarToken", "address"],
  definitions: [{ name: CREDENTIAL_EXPIRY_CHECK_TOOL_NAME }],
  factory: (env) => ({
    definitions: [
      {
        name: CREDENTIAL_EXPIRY_CHECK_TOOL_NAME,
        description: CREDENTIAL_EXPIRY_CHECK_DESCRIPTION,
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ],
    run: async (call) => {
      try {
        const candidates = await fetchTenantCredentials({
          hubConnectionsUrl: env.hubConnectionsUrl,
          tenantId: env.tenantId,
          sidecarToken: env.sidecarToken,
          address: env.address,
        });
        const due = findDueCredentialExpiries(candidates, new Date());
        return {
          callId: call.id,
          isError: false,
          content: JSON.stringify({
            due: due.map(({ credential }) => ({
              credentialId: credential.credentialId,
              name: credential.name,
              providerLabel: credential.providerLabel,
              expiresAt: credential.expiresAt,
            })),
          }),
        };
      } catch (err) {
        // report-error-ignore: this failure is surfaced to the calling
        // agent as an error tool result, which it reports plainly in
        // its reply rather than silently retrying — nothing here is
        // swallowed.
        return {
          callId: call.id,
          isError: true,
          content: `Failed to check credential expiry: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    },
  }),
});
