// Shared test harness for `createChatRoutes`' HTTP surface: a fake
// `ChatPlatform`, a tenant/principal-injecting mount, and the small
// request helpers every split test file (routes, workbench-settings,
// workbench-service) drives the same app through. Not a production
// module — lives in `test/` only.
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import type { TenantEnv } from "@intx/hub-api";
import type { ChatPlatform, CreateChatRoutesDeps } from "../src/routes";
import { createInMemoryChatStore } from "../src/store";
import { createInMemoryWorkbenchTenancyStore } from "../src/workbench-tenancy";
import { extractTextPreview, type MailContent } from "../src/codec";

export const TENANT = {
  id: "tnt_1",
  name: "Acme",
  slug: "acme",
  domain: "acme.example",
  parentId: null,
  config: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

export function principal(id: string) {
  return {
    id,
    tenantId: TENANT.id,
    kind: "user" as const,
    refId: id,
    status: "active" as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export function fakePlatform(
  opts: {
    invitable?: { id: string; name: string; description?: string }[];
    launchWorkbench?: (input: {
      tenantId: string;
      creatorPrincipalId: string;
      workbenchId: string;
      triggerAddress: string;
      definition: string;
    }) => Promise<{ instanceId: string }>;
    launchInvite?: (input: {
      tenantId: string;
      creatorPrincipalId: string;
      definitionId: string;
    }) => Promise<{ instanceId: string; address: string }>;
    fetchBlob?: (
      workbenchId: string,
      blobId: string,
    ) => Promise<string | Uint8Array>;
    resolveDefinitionIdByAddress?: (
      address: string,
    ) => Promise<string | undefined>;
    refreshAgentInstanceFromDefinition?: (
      tenantId: string,
      workbenchId: string,
      address: string,
    ) => Promise<void>;
    sendMail?: (input: {
      tenantId: string;
      workbenchId: string;
      principalId?: string;
      content: MailContent;
      fromWorkbenchId?: string;
    }) => Promise<{ id: string; createdAt: string }>;
  } = {},
): ChatPlatform & {
  refreshCalls: { tenantId: string; workbenchId: string; address: string }[];
  sentMail: {
    workbenchId: string;
    principalId?: string;
    content: MailContent;
    fromWorkbenchId?: string;
  }[];
  launchInviteCalls: {
    tenantId: string;
    creatorPrincipalId: string;
    definitionId: string;
  }[];
} {
  const sentMail: {
    workbenchId: string;
    principalId?: string;
    content: MailContent;
    fromWorkbenchId?: string;
  }[] = [];
  const launchInviteCalls: {
    tenantId: string;
    creatorPrincipalId: string;
    definitionId: string;
  }[] = [];
  const mailByWorkbench = new Map<
    string,
    { id: string; createdAt: string; mail: unknown }[]
  >();
  let mailCounter = 0;
  const refreshCalls: {
    tenantId: string;
    workbenchId: string;
    address: string;
  }[] = [];

  return {
    sentMail,
    launchInviteCalls,
    refreshCalls,
    async launchWorkbench(input) {
      if (opts.launchWorkbench !== undefined)
        return opts.launchWorkbench(input);
      return { instanceId: "launched" };
    },
    async launchInvite(input) {
      launchInviteCalls.push(input);
      if (opts.launchInvite !== undefined) return opts.launchInvite(input);
      return {
        instanceId: "ins_invited1",
        address: "ins_invited1@acme.example",
      };
    },
    async listInvitableDefinitions() {
      return opts.invitable ?? [];
    },
    async resolveDefinitionIdByAddress(address) {
      if (opts.resolveDefinitionIdByAddress !== undefined) {
        return opts.resolveDefinitionIdByAddress(address);
      }
      return undefined;
    },
    async refreshAgentInstanceFromDefinition(tenantId, workbenchId, address) {
      refreshCalls.push({ tenantId, workbenchId, address });
      if (opts.refreshAgentInstanceFromDefinition !== undefined) {
        return opts.refreshAgentInstanceFromDefinition(
          tenantId,
          workbenchId,
          address,
        );
      }
    },
    async sendMail(input) {
      if (opts.sendMail !== undefined) return opts.sendMail(input);
      const sentMailEntryBase = {
        workbenchId: input.workbenchId,
        content: input.content,
      };
      const withPrincipal =
        input.principalId !== undefined
          ? { ...sentMailEntryBase, principalId: input.principalId }
          : sentMailEntryBase;
      sentMail.push(
        input.fromWorkbenchId !== undefined
          ? { ...withPrincipal, fromWorkbenchId: input.fromWorkbenchId }
          : withPrincipal,
      );
      const id = `mail_${++mailCounter}`;
      const createdAt = new Date().toISOString();
      const list = mailByWorkbench.get(input.workbenchId) ?? [];
      const fromLocal = input.principalId ?? input.fromWorkbenchId ?? "unknown";
      list.push({
        id,
        createdAt,
        mail: {
          textBody: [{ partId: "1", type: "text/plain" }],
          bodyValues: { "1": { value: input.content.content } },
          attachments: [],
          from: [{ name: null, email: `${fromLocal}@acme.example` }],
        },
      });
      mailByWorkbench.set(input.workbenchId, list);
      return { id, createdAt };
    },
    async listMail(input) {
      // Matches the real platform's contract: a page is newest-first.
      const items = mailByWorkbench.get(input.workbenchId) ?? [];
      return { items: [...items].reverse() };
    },
    async getMail(input) {
      const items = mailByWorkbench.get(input.workbenchId) ?? [];
      return items.find((item) => item.id === input.messageId);
    },
    async listWorkbenchActivity(input) {
      const result: Record<
        string,
        { lastActivityAt?: string; unreadCount: number; preview?: string }
      > = {};
      for (const workbench of input.workbenches) {
        const items = mailByWorkbench.get(workbench.workbenchId) ?? [];
        if (items.length === 0) {
          result[workbench.workbenchId] = { unreadCount: 0 };
          continue;
        }
        const latest = items[items.length - 1];
        const lastActivityAt = latest?.createdAt;
        const unreadCount = items.filter(
          (item) =>
            workbench.sinceCreatedAt === undefined ||
            item.createdAt > workbench.sinceCreatedAt,
        ).length;
        if (lastActivityAt === undefined || latest === undefined) {
          result[workbench.workbenchId] = { unreadCount };
          continue;
        }
        const preview = extractTextPreview(latest.mail);
        result[workbench.workbenchId] =
          preview.length === 0
            ? { unreadCount, lastActivityAt }
            : { unreadCount, lastActivityAt, preview };
      }
      return result;
    },
    async fetchBlob(workbenchId, blobId) {
      if (opts.fetchBlob !== undefined)
        return opts.fetchBlob(workbenchId, blobId);
      return "";
    },
    subscribeToWorkbench() {
      return () => undefined;
    },
  };
}

export function mountAs(
  routes: Hono<TenantEnv>,
  principalId: string,
): Hono<TenantEnv> {
  const asPrincipal: MiddlewareHandler<TenantEnv> = async (c, next) => {
    c.set("tenant", TENANT);
    c.set("principal", principal(principalId));
    await next();
  };
  const app = new Hono<TenantEnv>();
  app.use("*", asPrincipal);
  app.route("/", routes);
  return app;
}

export function buildDeps(
  overrides: Partial<CreateChatRoutesDeps> = {},
): CreateChatRoutesDeps {
  return {
    store: createInMemoryChatStore(),
    platform: fakePlatform(),
    tenancy: createInMemoryWorkbenchTenancyStore(),
    requireGrant: () => async (_c, next) => {
      await next();
    },
    isInvitableDefinition: () => true,
    turnTimeoutMs: 60_000,
    workbenchHostInferencePreferences: async () => [
      { provider: "anthropic", model: "claude-sonnet-5" },
    ],
    ...overrides,
  };
}

export interface WorkbenchView {
  id: string;
  title: string;
  kind: string;
  pinned: boolean;
  participants: { address: string; handle: string }[];
  /** Present on create/reopen responses: the workbench's own tenancy
   * link, or null (with `legacy: true`) for a pre-tenancy workbench. */
  tenancy?: {
    tenantId: string;
    parentTenantId: string;
    slug: string;
  } | null;
}

export async function createWorkbench(
  app: Hono<TenantEnv>,
  body: Record<string, unknown>,
): Promise<{ response: Response; body: WorkbenchView }> {
  const response = await app.request("/workbenches", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: (await response.json()) as WorkbenchView };
}

export async function sendText(
  app: Hono<TenantEnv>,
  workbenchId: string,
  text: string,
): Promise<Response> {
  return app.request(`/workbenches/${workbenchId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parts: [{ kind: "text", text }] }),
  });
}
