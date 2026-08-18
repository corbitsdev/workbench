// Shared test harness for `createChatRoutes`' HTTP surface: a fake
// `ChatPlatform`, a tenant/principal-injecting mount, and the small
// request helpers every split test file (routes, channel-settings,
// channel-service) drives the same app through. Not a production
// module — lives in `test/` only.
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import type { TenantEnv } from "@intx/hub-api";
import type { ChatPlatform, CreateChatRoutesDeps } from "../src/routes";
import { createInMemoryChatStore } from "../src/store";
import { createInMemoryChannelTenancyStore } from "../src/channel-tenancy";
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
    launchChannel?: (input: {
      tenantId: string;
      creatorPrincipalId: string;
      channelId: string;
      triggerAddress: string;
      definition: string;
    }) => Promise<{ instanceId: string }>;
    launchInvite?: (input: {
      tenantId: string;
      creatorPrincipalId: string;
      definitionId: string;
    }) => Promise<{ instanceId: string; address: string }>;
    fetchBlob?: (
      channelId: string,
      blobId: string,
    ) => Promise<string | Uint8Array>;
    resolveDefinitionIdByAddress?: (
      address: string,
    ) => Promise<string | undefined>;
    refreshAgentInstanceFromDefinition?: (
      tenantId: string,
      channelId: string,
      address: string,
    ) => Promise<void>;
    sendMail?: (input: {
      tenantId: string;
      channelId: string;
      principalId?: string;
      content: MailContent;
      fromChannelId?: string;
    }) => Promise<{ id: string; createdAt: string }>;
  } = {},
): ChatPlatform & {
  refreshCalls: { tenantId: string; channelId: string; address: string }[];
  sentMail: {
    channelId: string;
    principalId?: string;
    content: MailContent;
    fromChannelId?: string;
  }[];
  launchInviteCalls: {
    tenantId: string;
    creatorPrincipalId: string;
    definitionId: string;
  }[];
} {
  const sentMail: {
    channelId: string;
    principalId?: string;
    content: MailContent;
    fromChannelId?: string;
  }[] = [];
  const launchInviteCalls: {
    tenantId: string;
    creatorPrincipalId: string;
    definitionId: string;
  }[] = [];
  const mailByChannel = new Map<
    string,
    { id: string; createdAt: string; mail: unknown }[]
  >();
  let mailCounter = 0;
  const refreshCalls: {
    tenantId: string;
    channelId: string;
    address: string;
  }[] = [];

  return {
    sentMail,
    launchInviteCalls,
    refreshCalls,
    async launchChannel(input) {
      if (opts.launchChannel !== undefined) return opts.launchChannel(input);
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
    async refreshAgentInstanceFromDefinition(tenantId, channelId, address) {
      refreshCalls.push({ tenantId, channelId, address });
      if (opts.refreshAgentInstanceFromDefinition !== undefined) {
        return opts.refreshAgentInstanceFromDefinition(
          tenantId,
          channelId,
          address,
        );
      }
    },
    async sendMail(input) {
      if (opts.sendMail !== undefined) return opts.sendMail(input);
      const sentMailEntryBase = {
        channelId: input.channelId,
        content: input.content,
      };
      const withPrincipal =
        input.principalId !== undefined
          ? { ...sentMailEntryBase, principalId: input.principalId }
          : sentMailEntryBase;
      sentMail.push(
        input.fromChannelId !== undefined
          ? { ...withPrincipal, fromChannelId: input.fromChannelId }
          : withPrincipal,
      );
      const id = `mail_${++mailCounter}`;
      const createdAt = new Date().toISOString();
      const list = mailByChannel.get(input.channelId) ?? [];
      const fromLocal = input.principalId ?? input.fromChannelId ?? "unknown";
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
      mailByChannel.set(input.channelId, list);
      return { id, createdAt };
    },
    async listMail(input) {
      // Matches the real platform's contract: a page is newest-first.
      const items = mailByChannel.get(input.channelId) ?? [];
      return { items: [...items].reverse() };
    },
    async getMail(input) {
      const items = mailByChannel.get(input.channelId) ?? [];
      return items.find((item) => item.id === input.messageId);
    },
    async listChannelActivity(input) {
      const result: Record<
        string,
        { lastActivityAt?: string; unreadCount: number; preview?: string }
      > = {};
      for (const channel of input.channels) {
        const items = mailByChannel.get(channel.channelId) ?? [];
        if (items.length === 0) {
          result[channel.channelId] = { unreadCount: 0 };
          continue;
        }
        const latest = items[items.length - 1];
        const lastActivityAt = latest?.createdAt;
        const unreadCount = items.filter(
          (item) =>
            channel.sinceCreatedAt === undefined ||
            item.createdAt > channel.sinceCreatedAt,
        ).length;
        if (lastActivityAt === undefined || latest === undefined) {
          result[channel.channelId] = { unreadCount };
          continue;
        }
        const preview = extractTextPreview(latest.mail);
        result[channel.channelId] =
          preview.length === 0
            ? { unreadCount, lastActivityAt }
            : { unreadCount, lastActivityAt, preview };
      }
      return result;
    },
    async fetchBlob(channelId, blobId) {
      if (opts.fetchBlob !== undefined)
        return opts.fetchBlob(channelId, blobId);
      return "";
    },
    subscribeToChannel() {
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
    tenancy: createInMemoryChannelTenancyStore(),
    requireGrant: () => async (_c, next) => {
      await next();
    },
    isInvitableDefinition: () => true,
    turnTimeoutMs: 60_000,
    channelHostInferencePreferences: async () => [
      { provider: "anthropic", model: "claude-sonnet-5" },
    ],
    ...overrides,
  };
}

export interface ChannelView {
  id: string;
  title: string;
  kind: string;
  pinned: boolean;
  participants: { address: string; handle: string }[];
  /** Present on create/reopen responses: the channel's own tenancy
   * link, or null (with `legacy: true`) for a pre-tenancy channel. */
  tenancy?: {
    tenantId: string;
    parentTenantId: string;
    slug: string;
  } | null;
}

export async function createChannel(
  app: Hono<TenantEnv>,
  body: Record<string, unknown>,
): Promise<{ response: Response; body: ChannelView }> {
  const response = await app.request("/channels", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: (await response.json()) as ChannelView };
}

export async function sendText(
  app: Hono<TenantEnv>,
  channelId: string,
  text: string,
): Promise<Response> {
  return app.request(`/channels/${channelId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parts: [{ kind: "text", text }] }),
  });
}
