// Corbits mount block — the single composition point where Workbench adds
// Corbits libraries (@corbits/artifacts, @corbits/agent-token, @corbits/mailbox,
// @corbits/cron, @corbits/memory, @corbits/oauth-core, @corbits/mcp,
// @corbits/webhooks) and live workflow-run SSE streaming on top of stock
// @intx/hub-api routes. See AGENTS.md: any other hub mount is cutover debt,
// never a pattern to extend.
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
import {
  pushSourceUpdates,
  type SidecarLookups,
  type SidecarRouter,
} from "@intx/hub-sessions";
import { getLogger } from "@intx/log";
import type { ConditionRegistry } from "@intx/types/authz";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { createHubMailboxAuthorizeSender } from "./mailbox-persist";
import { captureMailboxRequest, createMailboxDeliver } from "./mailbox-send";
import { createWorkflowRunStreamRoutes } from "./run-stream";
import { createWorkflowRunAuthenticator } from "./workflow-run-authenticator";

// The same condition registry `mountHubRoutes` builds by default when no
// registry is supplied -- kept as one local constant so every Corbits
// route factory below shares the identical registry rather than each
// re-deriving stock's own default.
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
    // Minting an agent token is minting a credential, so it is gated by the
    // same stock grant the credential routes are, not by tenant membership.
    const agentTokensApp = new Hono<TenantEnv>();
    mountAgentTokens(agentTokensApp, {
      db,
      requireGrant: requireGrant("credential:*", "create"),
      resolveTenantId: (ctx) => (ctx as { get(key: "tenant"): { id: string } }).get("tenant").id,
      // A token is scoped to the agent's `workflow` source asset: the
      // tenant-owned thing that already exists when the workbench mints the
      // token, before the deploy that would create a run.
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

  // A deployed agent has no sidecar token; it presents the bearer this hub
  // minted for its definition and is scoped to the run it names. One
  // verifier and one run lookup serve every run-scoped Corbits mount.
  const verifyAgentToken = createAgentTokenVerifier({ db });
  const resolveAgentRun = async (runAddress: string) => {
    if (runAddress === "") return null;
    const run = await db.query.workflowRun.findFirst({
      where: eq(workflowRun.address, runAddress),
    });
    if (run === undefined || run.principalId === null) return null;
    return { tenantId: run.tenantId, principalId: run.principalId, runId: run.id };
  };

  {
    const workflowArtifactsApi = new Hono<WorkflowArtifactEnv>();
    const workflowRunAuthenticator = createWorkflowRunAuthenticator({ db });
    mountWorkflowArtifacts(workflowArtifactsApi, {
      db,
      contentStore: InlineContentStore,
      resolveRunScope: (token, runAddress) => workflowRunAuthenticator.resolve(token, runAddress),
      agentToken: { verify: (ctx) => verifyAgentToken(ctx), resolveRun: resolveAgentRun },
    });
    app.route("/api/workflow-artifacts", workflowArtifactsApi);
  }

  {
    const mailboxApp = new Hono<TenantEnv>();
    // Registered before the routes: Hono runs handlers in registration order.
    mailboxApp.use("/me/inbox/send", captureMailboxRequest());
    mountMailbox(mailboxApp, {
      db: mailboxDb,
      bus: mailboxBus,
      resolvePrincipal: (ctx) => {
        const c = ctx as { get(key: "tenant" | "principal"): { id: string } };
        return { tenantId: c.get("tenant").id, principalId: c.get("principal").id };
      },
      // The address stock itself stamps on a person's outbound mail, so a
      // Sent copy and the agent's reply share one identity.
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
        // A person's refId is mixed case; a small model lowercases an address
        // before replying, so the canonical stamped form is lowercase.
        return `${principalRow.refId}@${tenantRow.domain}`.toLowerCase();
      },
      deliver: createMailboxDeliver({ app, persistMail }),
    });
    app.route(`${TENANT_PREFIX}/mailbox`, mailboxApp);
  }

  // The router every system-originated trigger (webhook, cron) goes
  // through. `HookMailRouter` types its payloads as `unknown` at the
  // package boundary; this just narrows them back to `sidecarRouter`'s own
  // types on the way through, with no behavior change.
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

  // A due schedule fires with nobody signed in, so it cannot ride the
  // mailbox persist path, which authorizes its sender against a live
  // routable endpoint. It is a system trigger like an inbound webhook,
  // so it takes the same route: the run is the authenticated sender of
  // its own signed trigger mail, with its grants materialized first.
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
        // A durable per-tenant key the recipient can verify against;
        // the sidecar rejects trigger mail from an unknown sender.
        systemSender: createTenantSystemSender({ db, principalKeyStore }),
      }),
    ),
    onDeliveryError: (error, schedule) => {
      reportError(error, {
        operation: "hub.cron.deliver",
        extra: { scheduleId: schedule.id, tenantId: schedule.tenantId },
      });
    },
    // Waiting is the ordinary gap between an agent's runs, not a fault —
    // it resolves itself the moment the agent comes back.
    onScheduleWaiting: (schedule) => {
      log.info("Cron schedule waiting for agent {definitionName}", {
        scheduleId: schedule.id,
        tenantId: schedule.tenantId,
        definitionName: schedule.definitionName,
      });
    },
    // A stopped schedule never fires again and no redeploy resumes it, so
    // the one report it gets has to be durable.
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

    // The same plane, reached by a deployed agent's bearer rather than a
    // browser session, and scoped to the run the bearer names.
    const workflowMemoryApi = new Hono<WorkflowMemoryEnv>();
    mountWorkflowMemory(workflowMemoryApi, {
      memory,
      agentToken: { verify: (ctx) => verifyAgentToken(ctx), resolveRun: resolveAgentRun },
    });
    app.route("/api/workflow-memory", workflowMemoryApi);
  }

  const hubPublicUrl = process.env["HUB_PUBLIC_URL"] ?? `http://127.0.0.1:${String(port)}`;
  // A loopback hub is local development, where MCP servers may be plain-http
  // loopback too; a public hub keeps discovery https-only.
  const hubHost = new URL(hubPublicUrl).hostname;
  const localDevHub = hubHost === "localhost" || hubHost.startsWith("127.") || hubHost === "[::1]";

  // "Continue with Codex"/"Continue with xAI": the whole loopback PKCE
  // flow runs here, so the verifier and the callback listener never
  // leave this process and the browser only learns a credential id.
  const oauthLoginApi = new Hono<TenantEnv>();
  const oauthProviders: OAuthLoginProviders = {
    [CODEX_PROVIDER]: {
      oauthConfig: codexOAuthConfig,
      exchange: (code: string, verifier: string, now: number) =>
        exchangeCodexCode(code, verifier, now),
      // The account id the refresher carries forward lives on the
      // credential, so the prior tokens need only supply the secret.
      refresh: (refreshSecret: string, now: number) =>
        refreshCodexTokens(refreshSecret, now, { access: "", refresh: refreshSecret }),
      // The Codex backend rejects inference without this header value.
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
  // Resource-URL logins (MCP servers) redirect back to a hub-root route
  // outside any tenant; it shares the login store with the tenant routes.
  const oauthLoginStore = createOAuthLoginStore();
  // The mount takes a plain Hono, so it rides its own router on the root.
  const oauthCallbackApi = new Hono();
  mountOAuthCallback(oauthCallbackApi, { store: oauthLoginStore, path: "/api/oauth/callback" });
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
      reportError(error, { operation: "hub.oauth-login", extra: { provider } });
    },
  });
  app.route(TENANT_PREFIX, oauthLoginApi);

  // Stock Interchange has no serving-time refresh hook, so a subscription
  // token that lapses between inference calls would simply fail the next
  // one; this renews it a little before expiry instead.
  const oauthTokenRefresher = createOAuthTokenRefresher({
    db,
    cipher: credentialCipher,
    providers: oauthProviders,
    intervalMs: 60_000,
    onRefreshed: ({ tenantId, credentialId }) => {
      // The same push the stock credentials route fires after a secret
      // rotation, so running sidecars get the new material.
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
        extra: { provider: provider ?? "", credentialId: credentialId ?? "" },
      });
    },
  });
  oauthTokenRefresher.start();

  {
    // The browser never holds an MCP server's token, so the one place a
    // catalog can be read is here, with the secret decrypted in-process.
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
