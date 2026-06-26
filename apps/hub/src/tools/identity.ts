import type { AgentTool } from "@intx/agent";
import type { DB } from "@intx/db";
import {
  IDENTITY_GET_DEFINITION,
  IDENTITY_SET_DEFINITION,
} from "@workbench/tools-agents";
import { resolveOwnerMemberPrincipalId } from "../lib/artifact-tools";
import {
  getIdentityAccounts,
  setIdentityAccount,
} from "../lib/member-identity";
import type { ContextToolEntry } from "../lib/tool-registry";

export { IDENTITY_GET_DEFINITION, IDENTITY_SET_DEFINITION };

type IdentityToolContext = {
  db: DB["db"];
  tenantId: string;
  principalId: string;
};

function jsonResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function parseProviders(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    !value.every((entry): entry is string => typeof entry === "string")
  ) {
    throw new Error("providers must be an array of strings");
  }
  const cleaned = value.map((p) => p.trim()).filter((p) => p.length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalMetadata(
  args: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const value = args.metadata;
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("metadata must be an object");
  }
  return value as Record<string, unknown>;
}

function createGetHandler(context: IdentityToolContext): AgentTool {
  return {
    kind: "string",
    definition: IDENTITY_GET_DEFINITION,
    handler: async (args) => {
      const providers = parseProviders(args.providers);

      const ownerPrincipalId = await resolveOwnerMemberPrincipalId(
        context.db,
        context,
      );
      // No owning member → no identity. Empty, not an error: the owner is
      // resolved from the caller's own context, so there is no other user's
      // identity to leak.
      if (ownerPrincipalId === null) {
        return jsonResult(providers ? { accounts: [] } : { providers: [] });
      }

      const accounts = await getIdentityAccounts(
        context.db,
        context.tenantId,
        ownerPrincipalId,
        providers,
      );

      // With an explicit provider filter, return the full accounts the caller
      // asked for. With none, return a compact index (provider + labels +
      // which is primary, no values/metadata) so the model can see what exists
      // without pulling every identifier into context.
      if (providers) {
        return jsonResult({ accounts });
      }

      const byProvider = new Map<
        string,
        { label: string | null; isPrimary: boolean }[]
      >();
      for (const account of accounts) {
        const list = byProvider.get(account.provider) ?? [];
        list.push({ label: account.label, isPrimary: account.isPrimary });
        byProvider.set(account.provider, list);
      }
      return jsonResult({
        providers: [...byProvider.entries()].map(([provider, list]) => ({
          provider,
          accounts: list,
        })),
      });
    },
  };
}

function createSetHandler(context: IdentityToolContext): AgentTool {
  return {
    kind: "string",
    definition: IDENTITY_SET_DEFINITION,
    handler: async (args) => {
      const provider = requiredString(args, "provider");
      const value = requiredString(args, "value");
      const label = optionalString(args, "label");
      const metadata = optionalMetadata(args);
      const primary = args.primary === true;

      const ownerPrincipalId = await resolveOwnerMemberPrincipalId(
        context.db,
        context,
      );
      // Fail closed: without an owning member there is nowhere user-scoped to
      // persist the account.
      if (ownerPrincipalId === null) {
        throw new Error(
          "Cannot save identity: this agent has no owning user to scope it to",
        );
      }

      const account = await setIdentityAccount(
        context.db,
        context.tenantId,
        ownerPrincipalId,
        {
          provider,
          value,
          ...(label !== undefined ? { label } : {}),
          primary,
          ...(metadata !== undefined ? { metadata } : {}),
        },
      );
      return jsonResult({ ok: true, account });
    },
  };
}

export function createIdentityTools(context: IdentityToolContext): AgentTool[] {
  return [createGetHandler(context), createSetHandler(context)];
}

export const IDENTITY_HUB_TOOLS: Record<string, ContextToolEntry> = {
  identity_get: {
    definition: IDENTITY_GET_DEFINITION,
    createTools: (ctx) =>
      createIdentityTools({
        db: ctx.db,
        tenantId: ctx.tenantId,
        principalId: ctx.principalId,
      }),
  },
  identity_set: {
    definition: IDENTITY_SET_DEFINITION,
    createTools: (ctx) =>
      createIdentityTools({
        db: ctx.db,
        tenantId: ctx.tenantId,
        principalId: ctx.principalId,
      }),
  },
};
