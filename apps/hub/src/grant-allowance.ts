// CL-6345: the composition-root bindings for `@corbits/approvals`'
// grant-allowance gate. Two ports live here because only the hub holds
// their ingredients:
//
//   - `createMcpServerToolsAllowanceLoader` — the live `tools/list`
//     read `@corbits/mcp-tools`' `mcp_call` classifier verifies a
//     downstream tool's `readOnlyHint` claim against, built from the
//     tenant's stored MCP connection (`@workbench/connections`) and its
//     decrypted token, mirroring how `mcp-credential-bindings.ts` names
//     the same connections for tool delivery.
//   - `createAllowanceAutoApprover` — the native-resolve binding that
//     flips a riding call's approval row "approved" with allowance
//     (null-principal) authority through `@intx/hub-api`'s
//     `resolveApproval`, so the ledgered decision and the resume signal
//     both travel the exact machinery a human click would.
import { and, eq } from "drizzle-orm";

import type { DB } from "@intx/db";
import { parseGrantRow, resolveProviderByName, schema } from "@intx/db";
import type { CredentialCipher } from "@intx/types";
import { credentialAad } from "@intx/types";
import { resolveApproval, type CreateApprovalRoutesDeps } from "@intx/hub-api";
import type { GrantRule } from "@intx/types/authz";
import type { GrantAllowanceGateDeps } from "@corbits/approvals";
import {
  listMcpTools,
  withMcpConnection,
  type McpServerToolsLoader,
} from "@corbits/mcp-tools";
import { listMcpServerConnections } from "@workbench/connections";
import { MCP_NO_TOKEN_SENTINEL } from "@corbits/credential-providers";

function bearerFetch(token: string | undefined): typeof fetch {
  if (token === undefined || token.length === 0) return fetch;
  return ((input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  }) as typeof fetch;
}

export function createMcpServerToolsAllowanceLoader(deps: {
  db: DB["db"];
  credentialCipher: CredentialCipher;
}): McpServerToolsLoader {
  return async (tenantId, serverSlug) => {
    const connections = await listMcpServerConnections(deps.db, tenantId);
    const connection = connections.find((c) => c.slug === serverSlug);
    if (connection === undefined || connection.url.length === 0) return null;

    const provider = await resolveProviderByName(
      deps.db,
      tenantId,
      `mcp:${serverSlug}`,
    );
    if (provider === null) return null;
    const credential = await deps.db.query.credential.findFirst({
      where: and(
        eq(schema.credential.providerId, provider.id),
        eq(schema.credential.status, "active"),
      ),
    });
    if (credential === undefined) return null;
    const secret = await deps.credentialCipher.decrypt(
      credential.secret,
      credentialAad(credential.id, "secret"),
    );
    const token = secret === MCP_NO_TOKEN_SENTINEL ? undefined : secret;
    try {
      return await withMcpConnection(
        { url: connection.url, fetchImpl: bearerFetch(token) },
        (client) => listMcpTools(client),
      );
    } catch {
      return null;
    }
  };
}

export function createTenantGrantLister(
  db: DB["db"],
): GrantAllowanceGateDeps["listTenantGrants"] {
  return async (tenantId) => {
    const rows = await db.query.grant.findMany({
      where: eq(schema.grant.tenantId, tenantId),
    });
    return rows.map((row): GrantRule => parseGrantRow(row));
  };
}

export function createRegisteredApprovalFinder(
  db: DB["db"],
): GrantAllowanceGateDeps["findRegisteredApproval"] {
  return async (correlationId) => {
    const row = await db.query.approval.findFirst({
      where: and(
        eq(schema.approval.correlationId, correlationId),
        eq(schema.approval.status, "pending"),
      ),
    });
    if (row === undefined) return null;
    return { approvalId: row.id, tenantId: row.tenantId };
  };
}

export function createAllowanceAutoApprover(
  deps: CreateApprovalRoutesDeps,
  log: (line: string) => void,
): GrantAllowanceGateDeps["autoApprove"] {
  return async ({ approvalId, tenantId, resource, grantId }) => {
    const result = await resolveApproval(deps, {
      approvalId,
      tenantId,
      principalId: null,
      status: "approved",
      scope: "once",
      decisionPayload: {
        outcome: "approved",
        message: `Auto-approved by grant allowance: read-only call covered by grant ${grantId} on ${resource}`,
      },
    });
    if (result.kind !== "resolved") {
      log(
        `grant-allowance: approval ${approvalId} auto-resolve returned "${result.kind}"`,
      );
      return false;
    }
    return true;
  };
}
