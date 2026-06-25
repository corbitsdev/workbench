import type { AgentTool } from "@intx/agent";
import { schema as intxSchema } from "@intx/db";
import type { DB } from "@intx/db";
import type { ToolDefinition } from "@intx/types/runtime";
import { and, desc, eq } from "drizzle-orm";

const PRINCIPAL_KINDS = ["user", "agent"] as const;
type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

const PRINCIPAL_STATUSES = [
  "active",
  "suspended",
  "invited",
  "deactivated",
] as const;
type PrincipalStatus = (typeof PRINCIPAL_STATUSES)[number];

const DEFAULT_STATUS: PrincipalStatus = "active";
const ALL_STATUSES = "all";
const STATUS_VALUES = [...PRINCIPAL_STATUSES, ALL_STATUSES] as const;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const LIST_PRINCIPALS_DEFINITION: ToolDefinition = {
  name: "list_principals",
  description:
    "List the principals (users and agents) in your tenant. Returns each principal with its id, kind (user or agent), referenced entity id, status, and tenant id. Use a member (user) principal id with list_agents to find the agents that operator owns. Defaults to active principals; pass kind or status to narrow.",
  inputSchema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        description:
          "Filter by principal kind: user or agent. Omit to include both.",
      },
      status: {
        type: "string",
        description:
          "Status filter: active, suspended, invited, deactivated, or all. Defaults to active. Use all to return every status.",
      },
      limit: {
        type: "number",
        description:
          "Maximum number of principals to return (1-200, default 50).",
      },
    },
    required: [],
  },
};

export type ListPrincipalsContext = {
  db: DB["db"];
  tenantId: string;
};

export function resolvePrincipalKind(
  value: unknown,
): PrincipalKind | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error("kind must be a string");
  }
  if (!PRINCIPAL_KINDS.includes(value as PrincipalKind)) {
    throw new Error(`kind must be one of: ${PRINCIPAL_KINDS.join(", ")}`);
  }
  return value as PrincipalKind;
}

export function resolvePrincipalStatusFilter(
  value: unknown,
): PrincipalStatus | undefined {
  if (value === undefined) return DEFAULT_STATUS;
  if (typeof value !== "string") {
    throw new Error("status must be a string");
  }
  if (value === ALL_STATUSES) return undefined;
  if (!PRINCIPAL_STATUSES.includes(value as PrincipalStatus)) {
    throw new Error(`status must be one of: ${STATUS_VALUES.join(", ")}`);
  }
  return value as PrincipalStatus;
}

function parseLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.floor(value)), MAX_LIMIT);
}

export function createPrincipalsTools(
  context: ListPrincipalsContext,
): AgentTool[] {
  return [
    {
      kind: "string",
      definition: LIST_PRINCIPALS_DEFINITION,
      handler: async (args) => {
        const kind = resolvePrincipalKind(args.kind);
        const status = resolvePrincipalStatusFilter(args.status);
        const limit = parseLimit(args.limit);

        const conditions = [
          eq(intxSchema.principal.tenantId, context.tenantId),
        ];
        if (kind !== undefined) {
          conditions.push(eq(intxSchema.principal.kind, kind));
        }
        if (status !== undefined) {
          conditions.push(eq(intxSchema.principal.status, status));
        }

        const rows = await context.db
          .select({
            principalId: intxSchema.principal.id,
            kind: intxSchema.principal.kind,
            refId: intxSchema.principal.refId,
            status: intxSchema.principal.status,
            tenantId: intxSchema.principal.tenantId,
          })
          .from(intxSchema.principal)
          .where(and(...conditions))
          .orderBy(desc(intxSchema.principal.createdAt))
          .limit(limit);

        return JSON.stringify({ principals: rows }, null, 2);
      },
    },
  ];
}
