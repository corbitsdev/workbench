import { createAgentTokenVerifier, mountAgentTokens } from "@corbits/agent-token";
import {
  InlineContentStore,
  mountArtifacts,
  mountWorkflowArtifacts,
  type WorkflowArtifactEnv,
} from "@corbits/artifacts";
import {
  CODEX_PROVIDER,
  codexOAuthConfig,
  exchangeCodexCode,
  refreshCodexTokens,
} from "@corbits/codex-provider";
import { createCronRoutes, createCronTicker, createRunTriggerCronDeliver } from "@corbits/cron";
import { reportError } from "@corbits/error-sink";
import {
  createInMemoryMailboxEventBus,
  createMailboxDb,
  createMailboxPersist,
  mountMailbox,
} from "@corbits/mailbox";
import { mountMcpDiscovery } from "@corbits/mcp/hub";
import {
  createMemory,
  loadMemoryConfig,
  mountWorkflowMemory,
  type WorkflowMemoryEnv,
} from "@corbits/memory";
import {
  createOAuthLoginStore,
  createOAuthTokenRefresher,
  mountOAuthCallback,
  mountOAuthLogin,
  type OAuthLoginProviders,
} from "@corbits/oauth-core/hub";
import {
  createRunTriggerDeliverer,
  createTenantSystemSender,
  installWebhooks,
  type HookMailRouter,
} from "@corbits/webhooks";
import {
  XAI_PROVIDER,
  exchangeXaiCode,
  refreshXaiTokens,
  xaiOAuthConfig,
} from "@corbits/xai-provider";
import { timeWindowEvaluator } from "@intx/authz";
import type { createEnvKeyCredentialCipher } from "@intx/crypto";
import type { createDB, createGrantStore, PrincipalKeyStore } from "@intx/db";
import {
  asset as assetTable,
  principal as principalTable,
  tenant as tenantTable,
  workflowRun,
} from "@intx/db/schema";
import {
  type AppEnv,
  createMailTriggeredRunGrantsMaterializer,
  createRequireGrant,
  type TenantEnv,
} from "@intx/hub-api";
import { pushSourceUpdates, type SidecarLookups, type SidecarRouter } from "@intx/hub-sessions";
import { getLogger } from "@intx/log";
import type { ConditionRegistry } from "@intx/types/authz";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { createHubMailboxAuthorizeSender } from "./mailbox-persist";
import { captureMailboxRequest, createMailboxDeliver } from "./mailbox-send";
import { createWorkflowRunStreamRoutes } from "./run-stream";
import { createWorkflowRunAuthenticator } from "./workflow-run-authenticator";

const grantConditionRegistry: ConditionRegistry = {
  time_window: timeWindowEvaluator,
};

const TENANT_PREFIX = "/api/tenants/:tenantId";

export type MountCorbitsDeps = {
  readonly app: Hono<AppEnv>;
  readonly db: ReturnType<typeof createDB>["db"];
  readonly databaseUrl: string;
  readonly port: number;
  readonly grantStore: ReturnType<typeof createGrantStore>;
  readonly principalKeyStore: PrincipalKeyStore;
  readonly credentialCipher: ReturnType<typeof createEnvKeyCredentialCipher>;
  readonly sidecarRouter: SidecarRouter;
  readonly lookups: SidecarLookups;
};

export type MountedCorbits = {
  stop(): void;
};

export async function mountCorbits({
  app,
  db,
  databaseUrl,
  port,
  grantStore,
  principalKeyStore,
  credentialCipher,
  sidecarRouter,
  lookups,
}: MountCorbitsDeps): Promise<MountedCorbits> {
  const log = getLogger(["hub"]);
  const requireGrant = createRequireGrant({
    grantStore,
    conditionRegistry: grantConditionRegistry,
  });

  const { db: mailboxDb } = createMailboxDb(databaseUrl);
  const mailboxBus = createInMemoryMailboxEventBus();
  const persistMail = createMailboxPersist(mailboxDb, {
    upstream: async () => [],
    authorizeSender: createHubMailboxAuthorizeSender(db),
    bus: mailboxBus,
  });
  // `createSidecarRouter` captured `lookups` before this wrapper existed;
  // mutating it in place ensures agent outbound mail also lands in principal inboxes.
  lookups.persistMail = persistMail;

  {
    const artifactsApi = new Hono<TenantEnv>();
    mountArtifacts(artifactsApi, {
      db,
      contentStore: InlineContentStore,
      requireGrant,
    });
    app.route(TENANT_PREFIX, artifactsApi);
  }

  app.route(
    TENANT_PREFIX,
    createWorkflowRunStreamRoutes({
      db,
      sidecarRouter,
      requireGrant,
    }),
  );

  {
    const agentTokensApp = new Hono<TenantEnv>();
    mountAgentTokens(agentTokensApp, {
      db,
      requireGrant: requireGrant("credential:*", "create"),
      resolveTenantId: (ctx) => (ctx as { get(key: "tenant"): { id: string } }).get("tenant").id,
      // Scoped to the `workflow` source asset so the workbench can mint the
      // token before the deploy that creates the run.
      resolveDefinition: async (tenantId, definitionId) => {
        const row = await db.query.asset.findFirst({
          where: and(
            eq(assetTable.id, definitionId),
            eq(assetTable.tenantId, tenantId),
            eq(assetTable.kind, "workflow"),
          ),
        });
        return row !== undefined;
      },
    });
    app.route(TENANT_PREFIX, agentTokensApp);
  }

  const verifyAgentToken = createAgentTokenVerifier({ db });
  const resolveAgentRun = async (runAddress: string) => {
    if (runAddress === "") return null;
    const run = await db.query.workflowRun.findFirst({
      where: eq(workflowRun.address, runAddress),
    });
    if (run === undefined || run.principalId === null) return null;
    return {
      tenantId: run.tenantId,
      principalId: run.principalId,
      runId: run.id,
    };
  };

  {
    const workflowArtifactsApi = new Hono<WorkflowArtifactEnv>();
    const workflowRunAuthenticator = createWorkflowRunAuthenticator({ db });
    mountWorkflowArtifacts(workflowArtifactsApi, {
      db,
      contentStore: InlineContentStore,
      resolveRunScope: (token, runAddress) => workflowRunAuthenticator.resolve(token, runAddress),
      agentToken: {
        verify: (ctx) => verifyAgentToken(ctx),
        resolveRun: resolveAgentRun,
      },
    });
    app.route("/api/workflow-artifacts", workflowArtifactsApi);
  }

  {
    const mailboxApp = new Hono<TenantEnv>();
    mailboxApp.use("/me/inbox/send", captureMailboxRequest());
    mountMailbox(mailboxApp, {
      db: mailboxDb,
      bus: mailboxBus,
      resolvePrincipal: (ctx) => {
        const c = ctx as { get(key: "tenant" | "principal"): { id: string } };
        return {
          tenantId: c.get("tenant").id,
          principalId: c.get("principal").id,
        };
      },
      senderAddressFor: async (principal) => {
        const [tenantRow] = await db
          .select({ domain: tenantTable.domain })
          .from(tenantTable)
          .where(eq(tenantTable.id, principal.tenantId))
          .limit(1);
        if (tenantRow === undefined) {
          throw new Error(`no tenant "${principal.tenantId}" to address a mailbox sender from`);
        }
        const [principalRow] = await db
          .select({ refId: principalTable.refId })
          .from(principalTable)
          .where(eq(principalTable.id, principal.principalId))
          .limit(1);
        if (principalRow === undefined) {
          throw new Error(`no principal "${principal.principalId}" to address a mailbox sender as`);
        }
        // Small models lowercase addresses before replying, so stamp lowercase canonically.
        return `${principalRow.refId}@${tenantRow.domain}`.toLowerCase();
      },
      deliver: createMailboxDeliver({ app, persistMail }),
    });
    app.route(`${TENANT_PREFIX}/mailbox`, mailboxApp);
  }

  const systemTriggerMailRouter: HookMailRouter = {
    routeMail: (address, rawMessage, authenticatedSender, messageId) => {
      if (!sidecarRouter.getRoutableAddresses().includes(address)) {
        return false;
      }
      void sidecarRouter
        .routeMail(address, rawMessage, authenticatedSender, messageId)
        .catch((error: unknown) => {
          reportError(error, {
            operation: "hub.systemTriggerMailRouter.routeMail",
            extra: { address, authenticatedSender },
          });
        });
      return true;
    },
    sendRunGrants: (address, runId, stepGrants, senderIdentities) =>
      sidecarRouter.sendRunGrants(
        address,
        runId,
        stepGrants as Parameters<typeof sidecarRouter.sendRunGrants>[2],
        senderIdentities as Parameters<typeof sidecarRouter.sendRunGrants>[3],
      ),
  };

  app.route(
    `${TENANT_PREFIX}/cron`,
    createCronRoutes({
      db,
      requireGrant,
    }),
  );

  // Due schedules fire without a signed-in user, so they use the system-trigger
  // path rather than mailbox persist (which requires a live routable sender).
  const cronTicker = createCronTicker({
    db,
    intervalMs: 60_000,
    deliver: createRunTriggerCronDeliver(
      createRunTriggerDeliverer({
        router: systemTriggerMailRouter,
        materialize: createMailTriggeredRunGrantsMaterializer({
          db,
          principalKeyStore,
          grantStore,
        }),
        tenantDomain: async (tenantId) => {
          const [tenantRow] = await db
            .select({ domain: tenantTable.domain })
            .from(tenantTable)
            .where(eq(tenantTable.id, tenantId))
            .limit(1);
          if (tenantRow === undefined) {
            throw new Error(`no tenant "${tenantId}" to address cron mail from`);
          }
          return tenantRow.domain;
        },
        senderLocalPart: "cron",
        systemSender: createTenantSystemSender({ db, principalKeyStore }),
      }),
    ),
    onDeliveryError: (error, schedule) => {
      reportError(error, {
        operation: "hub.cron.deliver",
        extra: { scheduleId: schedule.id, tenantId: schedule.tenantId },
      });
    },
    onScheduleWaiting: (schedule) => {
      log.info("Cron schedule waiting for agent {definitionName}", {
        scheduleId: schedule.id,
        tenantId: schedule.tenantId,
        definitionName: schedule.definitionName,
      });
    },
    onScheduleStopped: (schedule) => {
      reportError(
        new Error(`cron schedule stopped: ${schedule.reason} (${schedule.definitionName})`),
        {
          operation: "hub.cron.schedule_stopped",
          extra: {
            scheduleId: schedule.id,
            tenantId: schedule.tenantId,
            definitionName: schedule.definitionName,
            reason: schedule.reason,
          },
        },
      );
    },
  });
  cronTicker.start();

  {
    const memoryApp = new Hono<TenantEnv>();
    const memory = createMemory({
      app: memoryApp,
      config: loadMemoryConfig(),
      grantStore,
      conditionRegistry: grantConditionRegistry,
    });
    app.route("/", memoryApp);

    const workflowMemoryApi = new Hono<WorkflowMemoryEnv>();
    mountWorkflowMemory(workflowMemoryApi, {
      memory,
      agentToken: {
        verify: (ctx) => verifyAgentToken(ctx),
        resolveRun: resolveAgentRun,
      },
    });
    app.route("/api/workflow-memory", workflowMemoryApi);
  }

  const hubPublicUrl = process.env["HUB_PUBLIC_URL"] ?? `http://127.0.0.1:${String(port)}`;
  const hubHost = new URL(hubPublicUrl).hostname;
  const localDevHub = hubHost === "localhost" || hubHost.startsWith("127.") || hubHost === "[::1]";

  const oauthLoginApi = new Hono<TenantEnv>();
  const oauthProviders: OAuthLoginProviders = {
    [CODEX_PROVIDER]: {
      oauthConfig: codexOAuthConfig,
      exchange: (code: string, verifier: string, now: number) =>
        exchangeCodexCode(code, verifier, now),
      refresh: (refreshSecret: string, now: number) =>
        refreshCodexTokens(refreshSecret, now, {
          access: "",
          refresh: refreshSecret,
        }),
      metadata: (tokens) =>
        "accountId" in tokens && typeof tokens.accountId === "string"
          ? { accountId: tokens.accountId }
          : {},
    },
    [XAI_PROVIDER]: {
      oauthConfig: xaiOAuthConfig,
      exchange: (code: string, verifier: string, now: number) =>
        exchangeXaiCode(code, verifier, now),
      refresh: (refreshSecret: string, now: number) => refreshXaiTokens(refreshSecret, now),
    },
  };
  const oauthLoginStore = createOAuthLoginStore();
  const oauthCallbackApi = new Hono();
  mountOAuthCallback(oauthCallbackApi, {
    store: oauthLoginStore,
    path: "/api/oauth/callback",
  });
  app.route("/", oauthCallbackApi);
  mountOAuthLogin(oauthLoginApi, {
    store: oauthLoginStore,
    callbackUrl: `${hubPublicUrl.replace(/\/+$/, "")}/api/oauth/callback`,
    clientName: "Workbench",
    db,
    cipher: credentialCipher,
    requireGrant: requireGrant("credential:*", "create"),
    providers: oauthProviders,
    onError: (error, { provider }) => {
      reportError(error, {
        operation: "hub.oauth-login",
        extra: { provider },
      });
    },
  });
  app.route(TENANT_PREFIX, oauthLoginApi);

  const oauthTokenRefresher = createOAuthTokenRefresher({
    db,
    cipher: credentialCipher,
    providers: oauthProviders,
    intervalMs: 60_000,
    onRefreshed: ({ tenantId, credentialId }) => {
      void pushSourceUpdates(db, sidecarRouter, tenantId, credentialCipher).catch(
        (error: unknown) => {
          reportError(error, {
            operation: "hub.oauth-refresh.push",
            extra: { tenantId, credentialId },
          });
        },
      );
    },
    onError: (error, { provider, credentialId }) => {
      reportError(error, {
        operation: "hub.oauth-refresh",
        extra: {
          provider: provider ?? "",
          credentialId: credentialId ?? "",
        },
      });
    },
  });
  oauthTokenRefresher.start();

  {
    const mcpApi = new Hono<TenantEnv>();
    mountMcpDiscovery(mcpApi, {
      allowLoopback: localDevHub,
      db,
      cipher: credentialCipher,
      requireGrant: requireGrant("credential:*", "read"),
      onError: (error, { url }) => {
        reportError(error, { operation: "hub.mcp-discover", extra: { url } });
      },
    });
    app.route(TENANT_PREFIX, mcpApi);
  }

  await installWebhooks({
    app,
    db,
    credentialCipher,
    principalKeyStore,
    router: systemTriggerMailRouter,
  });

  return {
    stop() {
      cronTicker.stop();
      oauthTokenRefresher.stop();
    },
  };
}
