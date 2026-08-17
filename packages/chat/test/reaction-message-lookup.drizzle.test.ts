// DB-gated: skipped when no DATABASE_URL is reachable, mirroring
// `../../folded-runs/test/scope-routes.drizzle.test.ts`. Runs the real
// platform schema (`@intx/db`'s `runMigrations`) into its own named
// schema on the shared e2e database, so `messageExistsInChannel`'s fix
// is proven against real `session_mail` rows and a real query — never
// a hand-rolled fake `db`.
//
// CL-6095: `messageExistsInChannel` used to resolve a `messageId` by
// fetching ONE page of `listMail` (`MAIL_PAGE_SIZE` = 50) and linearly
// scanning it. A reaction/pin toggle against a message older than the
// newest 50 in its channel 404'd — not because the message didn't
// exist, but because it never made it onto the page the handler
// happened to look at. This seeds 60 messages and reacts to one 55
// back (well past page one) to prove the fix (`ChatPlatform.getMail`,
// an id-scoped lookup) resolves it directly instead.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { createDB, runMigrations, dropSchema } from "@intx/db";
import { schema } from "@intx/db";
import type {
  AssetService,
  EventCollectorRegistry,
  SessionService,
  SidecarRouter,
} from "@intx/hub-sessions";
import type { TenantEnv } from "@intx/hub-api";

import { dbTargetFromUrl } from "../../../scripts/db-setup";
import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { createChatRoutes } from "../src/routes";
import { createHubChatPlatform } from "../src/platform-adapter";
import { createInMemoryChatStore } from "../src/store";
import { createInMemoryChannelTenancyStore } from "../src/channel-tenancy";
import { createInMemoryReactionStore } from "../src/reactions";

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const SCHEMA = "chat_reaction_message_lookup_test";
const TENANT_ID = "tnt_msg_lookup";
const DEFINITION_ID = "wfd_msg_lookup_host";
const HOST_PRINCIPAL_ID = "prn_msg_lookup_host";
const SESSION_ID = "ses_msg_lookup";
const CHANNEL_ID = "run_msg_lookup_channel1";
const MESSAGE_COUNT = 60;
// Well past `MAIL_PAGE_SIZE` (50) messages back from the newest.
const TARGET_INDEX_FROM_NEWEST = 55;

const RAW_MIME = new TextEncoder().encode(
  "Content-Type: text/plain\r\n\r\nhello",
);

describeIfDb("reaction toggle: message lookup past the first mail page", () => {
  const target = dbTargetFromUrl(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );

  beforeAll(async () => {
    await runMigrations(target, { schema: SCHEMA });
  }, 60_000);

  afterAll(async () => {
    await dropSchema(target, { schema: SCHEMA });
  }, 60_000);

  test("reacting to a message 55 back resolves it directly, not via a 50-item page scan", async () => {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    let targetMessageId: string | undefined;
    try {
      await db.insert(schema.tenant).values({
        id: TENANT_ID,
        name: "Message Lookup Tenant",
        slug: "message-lookup-tenant",
        domain: "message-lookup.workbench.test",
      });
      await db.insert(schema.workflowDefinition).values({
        id: DEFINITION_ID,
        tenantId: TENANT_ID,
        name: "channel-host",
        status: "deployed",
      });
      await db.insert(schema.principal).values({
        id: HOST_PRINCIPAL_ID,
        tenantId: TENANT_ID,
        kind: "agent",
        refId: HOST_PRINCIPAL_ID,
        status: "active",
      });
      await db.insert(schema.workflowRun).values({
        id: CHANNEL_ID,
        definitionId: DEFINITION_ID,
        anchorRunId: CHANNEL_ID,
        tenantId: TENANT_ID,
        principalId: HOST_PRINCIPAL_ID,
        address: `${CHANNEL_ID}@message-lookup.workbench.test`,
        status: "running",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      await db.insert(schema.agentSession).values({
        id: SESSION_ID,
        tenantId: TENANT_ID,
        agentId: DEFINITION_ID,
        principalId: HOST_PRINCIPAL_ID,
        status: "active",
      });

      const baseTime = new Date("2026-01-02T00:00:00.000Z").getTime();
      const mailRows = Array.from({ length: MESSAGE_COUNT }, (_, i) => ({
        id: `mail_lookup_${String(MESSAGE_COUNT - i).padStart(3, "0")}`,
        sessionId: SESSION_ID,
        tenantId: TENANT_ID,
        direction: "inbound" as const,
        status: "delivered" as const,
        raw: Buffer.from(RAW_MIME),
        // i = 0 is newest; later i are progressively older.
        createdAt: new Date(baseTime - i * 1_000),
      }));
      await db.insert(schema.sessionMail).values(mailRows);

      const target55Back = mailRows[TARGET_INDEX_FROM_NEWEST];
      if (target55Back === undefined) {
        throw new Error(
          "unreachable: MESSAGE_COUNT > TARGET_INDEX_FROM_NEWEST",
        );
      }
      targetMessageId = target55Back.id;

      const platform = createHubChatPlatform({
        hubPublicKey: "hub-key",
        db,
        sessionService: {} as unknown as SessionService,
        assetService: {} as unknown as AssetService,
        sidecarRouter: {} as unknown as SidecarRouter,
        eventCollectors: {} as unknown as EventCollectorRegistry,
        noopInferenceBaseUrl: "https://hub.invalid/api/chat/noop-inference",
      });

      const store = createInMemoryChatStore();
      await store.createChannelSettings({
        tenantId: TENANT_ID,
        channelId: CHANNEL_ID,
        settings: { kind: "channel" },
        updatedBy: "prn_caller",
      });

      const routes = createChatRoutes({
        store,
        platform,
        tenancy: createInMemoryChannelTenancyStore(),
        reactions: createInMemoryReactionStore(),
        requireGrant: () => async (_c, next) => {
          await next();
        },
        isInvitableDefinition: () => true,
        turnTimeoutMs: 60_000,
        channelHostInferencePreferences: async () => [
          { provider: "anthropic", model: "claude-sonnet-5" },
        ],
      });

      const tenant = {
        id: TENANT_ID,
        name: "Message Lookup Tenant",
        slug: "message-lookup-tenant",
        domain: "message-lookup.workbench.test",
        parentId: null,
        config: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const caller = {
        id: "prn_caller",
        tenantId: TENANT_ID,
        kind: "user" as const,
        refId: "prn_caller",
        status: "active" as const,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const asPrincipal: MiddlewareHandler<TenantEnv> = async (c, next) => {
        c.set("tenant", tenant);
        c.set("principal", caller);
        await next();
      };
      const app = new Hono<TenantEnv>();
      app.use("*", asPrincipal);
      app.route("/", routes);

      const response = await app.request(
        `/channels/${CHANNEL_ID}/messages/${targetMessageId}/reactions/toggle`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ emoji: "👍" }),
        },
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        emoji: string;
        count: number;
        reactedByMe: boolean;
      };
      expect(body).toEqual({ emoji: "👍", count: 1, reactedByMe: true });
    } finally {
      await close();
    }
  });
});
