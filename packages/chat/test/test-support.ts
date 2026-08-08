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
import type { MailContent } from "../src/codec";

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
    invitable?: { id: string; name: string }[];
    launchInvite?: (input: {
      tenantId: string;
      creatorPrincipalId: string;
      definitionId: string;
    }) => Promise<{ instanceId: string; address: string }>;
  } = {},
): ChatPlatform & {
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

  return {
    sentMail,
    launchInviteCalls,
    async launchChannel() {
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
    async sendMail(input) {
      sentMail.push({
        channelId: input.channelId,
        ...(input.principalId !== undefined
          ? { principalId: input.principalId }
          : {}),
        content: input.content,
        ...(input.fromChannelId !== undefined
          ? { fromChannelId: input.fromChannelId }
          : {}),
      });
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
    async fetchBlob() {
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
    requireGrant: () => async (_c, next) => {
      await next();
    },
    turnTimeoutMs: 60_000,
    channelHostInferencePreferences: [
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
    body: JSON.stringify([{ kind: "text", text }]),
  });
}
