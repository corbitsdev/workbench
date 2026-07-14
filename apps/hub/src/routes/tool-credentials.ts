import { Hono } from "hono";
import { type } from "arktype";
import { describeRoute, resolver } from "hono-openapi";
import { eq } from "drizzle-orm";
import { schema as intxSchema, resolveCredentialRequirement } from "@intx/db";
import type { HubDb } from "../db";
import { getLogger } from "@intx/log";
import {
  ToolCredentialsRequest,
  type ToolCredential,
} from "@workbench/tool-credentials";
import { providersForToolPackages } from "@workbench/agents";
import { ToolPackagePin } from "@intx/types/tool-packages";
import { requestBodySchema } from "../lib/openapi";
import { decryptToolCredentialSecret } from "../lib/credential-crypto";
import { resolveToolCredentialMemberPrincipal } from "../lib/tool-credential-member-principal";
import {
  resolveMemberOrTenantToolCredential,
  type MemberToolCredential,
} from "../lib/member-tool-credential";

const log = getLogger(["api", "tool-credentials"]);

const ToolPackagePins = ToolPackagePin.array();

// Response shapes for the OpenAPI spec. The hub admin CLI consumes /openapi.json
// to discover this operation; these schemas document (they do not replace) the
// handler's existing manual validation. The per-provider credential carries a
// secret apiKey — never logged or echoed; documented as opaque here.
const ToolCredentialsResponse = type({
  credentials: type.Record("string", { apiKey: "unknown", baseURL: "string" }),
});
const ErrorResponse = type({ error: "string" });

/**
 * The credential providers an agent may request: the providers of the tool
 * packages it has pinned. Derived from the agent's persisted `toolPackages`
 * (the native pins), so a workflow step — provisioned as a real agent row with
 * its step pins — is gated identically to any other agent. A holder of the
 * sidecar token cannot resolve arbitrary tenant credentials by name.
 */
function allowedProvidersForAgent(toolPackages: unknown): Set<string> {
  const pins = ToolPackagePins(toolPackages);
  if (pins instanceof type.errors) return new Set();
  return new Set(providersForToolPackages(pins));
}

/**
 * Credential rail for in-sidecar native tool packages. Resolves the
 * tenant-owned credential for each requested provider and returns the
 * apiKey + baseURL, scoped to the providers the agent is actually allowed
 * to use (a holder of the sidecar token cannot resolve arbitrary tenant
 * credentials by name). Delivered separately from inference sources.
 */
export function createToolCredentialsRouter(
  db: HubDb,
  sidecarToken: string,
  resolveCredential: typeof resolveCredentialRequirement = resolveCredentialRequirement,
  resolveMemberOrTenant: (
    db: HubDb,
    tenantId: string,
    memberPrincipalId: string,
    providerName: string,
  ) => Promise<MemberToolCredential | null> = resolveMemberOrTenantToolCredential,
): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (c.req.header("Authorization") !== `Bearer ${sidecarToken}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return next();
  });

  router.post(
    "/tools/credentials",
    describeRoute({
      tags: ["Tool Credentials"],
      summary: "Resolve tool credentials for an agent",
      description:
        "Sidecar-gated (sidecar token). Resolves credentials for each requested provider (member OAuth when `workflowRunId` or `memberPrincipalId` identifies a user principal, otherwise tenant-owned keys), scoped to providers the named agent may use (from pinned tool packages). Response `apiKey` values are secrets. Body: `tenantId`, `agentId`, `providerNames`, optional `workflowRunId` (run creator principal), optional `memberPrincipalId` (live session owner).",
      requestBody: {
        required: true,
        description:
          "Body: `tenantId`, `agentId`, `providerNames`; optional `workflowRunId`, `memberPrincipalId`.",
        content: {
          "application/json": {
            schema: requestBodySchema(ToolCredentialsRequest),
          },
        },
      },
      responses: {
        200: {
          description:
            "Resolved credentials (apiKey values are secrets). Providers with no configured credential are omitted from the map rather than failing the request, so one unconfigured tool degrades only itself.",
          content: {
            "application/json": { schema: resolver(ToolCredentialsResponse) },
          },
        },
        400: {
          description: "Invalid JSON or request body",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        401: {
          description: "Missing or invalid sidecar token",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        403: {
          description:
            "Agent may not request one or more of the named providers",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "Unknown agent",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        500: {
          description: "Credential resolution failed",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON" }, 400);
      }
      const parsed = ToolCredentialsRequest(body);
      if (parsed instanceof type.errors) {
        return c.json({ error: `Invalid request: ${parsed.summary}` }, 400);
      }

      const agentRow = await db.query.agent.findFirst({
        where: eq(intxSchema.agent.id, parsed.agentId),
      });
      if (!agentRow) {
        return c.json({ error: `Agent not found: ${parsed.agentId}` }, 404);
      }
      if (agentRow.tenantId !== parsed.tenantId) {
        return c.json(
          { error: "Agent does not belong to the claimed tenant" },
          403,
        );
      }
      const allowed = allowedProvidersForAgent(agentRow.toolPackages);
      const forbidden = parsed.providerNames.filter((p) => !allowed.has(p));
      if (forbidden.length > 0) {
        return c.json(
          {
            error: `Agent ${parsed.agentId} may not request providers: ${forbidden.join(", ")}`,
          },
          403,
        );
      }

      const memberPrincipalId = await resolveToolCredentialMemberPrincipal(db, {
        tenantId: parsed.tenantId,
        agentId: parsed.agentId,
        workflowRunId: parsed.workflowRunId,
        memberPrincipalId: parsed.memberPrincipalId,
      });

      const credentials: Record<string, ToolCredential> = {};
      for (const providerName of parsed.providerNames) {
        try {
          if (memberPrincipalId !== null) {
            const memberCred = await resolveMemberOrTenant(
              db,
              parsed.tenantId,
              memberPrincipalId,
              providerName,
            );
            if (!memberCred) {
              log.warn(
                "No member or tenant credential for requested provider; skipping",
                {
                  tenantId: parsed.tenantId,
                  agentId: parsed.agentId,
                  providerName,
                  memberPrincipalId,
                },
              );
              continue;
            }
            credentials[providerName] = {
              apiKey: memberCred.apiKey,
              baseURL: memberCred.baseURL,
            };
            continue;
          }

          const resolved = await resolveCredential(
            db,
            parsed.tenantId,
            { providerName, source: "tenant" },
            null,
            null,
          );
          if (!resolved) {
            log.warn(
              "No credential configured for requested provider; skipping",
              {
                tenantId: parsed.tenantId,
                agentId: parsed.agentId,
                providerName,
              },
            );
            continue;
          }
          const providerRow = await db.query.provider.findFirst({
            where: (p, { eq: eqp }) => eqp(p.id, resolved.providerId),
          });
          const metadata = (providerRow?.metadata ?? {}) as { baseURL?: string };
          credentials[providerName] = {
            apiKey: decryptToolCredentialSecret(resolved.secret),
            baseURL: metadata.baseURL ?? "",
          };
        } catch (err) {
          log.error("Tool credential resolution failed", {
            tenantId: parsed.tenantId,
            providerName,
            error: err instanceof Error ? err.message : String(err),
          });
          return c.json(
            { error: `Credential resolution failed for ${providerName}` },
            500,
          );
        }
      }

      return c.json({ credentials });
    },
  );

  return router;
}
