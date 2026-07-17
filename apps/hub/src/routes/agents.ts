import { eq, and, inArray, notInArray, isNull } from "drizzle-orm";
import { type } from "arktype";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { schema as intxSchema } from "@intx/db";
import type { DB } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { getLogger } from "@intx/log";
import type {
  SessionService,
  SidecarRouter,
  EventCollectorRegistry,
} from "@intx/hub-sessions";
import type { GrantStore } from "@intx/types/authz";
import { matchPattern } from "@intx/authz";
import { AGENT_TEMPLATES } from "@workbench/agents";
import { memberAgentInstance } from "../db/schema";
import type { HubDb } from "../db";
import {
  describeLaunchError,
  launchFailureLogMessage,
  isAgentAlreadyExistsError,
  launchAgentSession,
  type LaunchErrorDescription,
} from "../services/agent-provisioning";
import { coalesceInstanceLaunch } from "../services/instance-launch-coalescer";
import { requestBodySchema } from "../lib/openapi";
import {
  reconcileMemberInstanceGrants,
  refreshInstanceGrantsFromDefinition,
} from "../services/grant-reconcile";
import { getRootTenantId, lookupMember } from "../lib/tenant-provisioning";

const log = getLogger(["api", "agents"]);

const { agent, agentInstance, agentSession, principal, tenant, grant } =
  intxSchema;

// Ephemeral workflow step/supervisor instances are launched by the sidecar
// workflow-host and carry a session-derived id (`ins_ses_…`). They hold no
// durable conversation history, so they are the only instances safe to
// hard-delete (which CASCADE-removes inference_turn rows).
const EPHEMERAL_WORKFLOW_INSTANCE_PREFIX = "ins_ses_";
function isEphemeralWorkflowInstance(instanceId: string): boolean {
  return instanceId.startsWith(EPHEMERAL_WORKFLOW_INSTANCE_PREFIX);
}

// Response shapes for the OpenAPI spec. The hub admin CLI consumes /openapi.json
// to discover these operations; these schemas document (they do not replace) the
// handlers' existing manual validation.
const AgentInstance = type({
  id: "string",
  agentId: "string",
  agentName: "string",
  agentDescription: "string | null",
  tenantId: "string",
  address: "string",
  status: "string",
  credentialRequirements: "unknown",
  capabilities: "unknown",
  createdAt: "string",
});
const AgentInstanceListResponse = type({ data: AgentInstance.array() });

const AgentTemplate = type({
  key: "string",
  name: "string",
  description: "string",
  tools: "unknown",
});
const AgentTemplateListResponse = type({ data: AgentTemplate.array() });

const LaunchSessionResponse = type({
  launched: "boolean",
  // Interchange agent session id so the client can scope Action Requests to
  // this chat (CL-3286). Null when the instance has no session row yet.
  sessionId: "string | null",
});

const LaunchSessionRequest = type({
  "pageContext?": "string",
});

const ReconcileGrantsResponse = type({
  templateKey: "string",
  reconciled: "number",
  pushed: "number",
  skipped: "number",
});

const CreateInstanceRequest = type({ templateKey: "string" });
const CreateInstanceResponse = type({
  instanceId: "string",
  created: "boolean",
});

const ErrorResponse = type({ error: "string" });
const LaunchErrorResponse = type({
  error: "string",
  phase: "string | null",
  detail: "string",
});

// ─── Route ────────────────────────────────────────────────────────

export function createAgentProvisioningRouter(
  db: DB["db"],
  sessionService: SessionService,
  grantStore: GrantStore,
  sidecarRouter: SidecarRouter,
  eventCollectors: EventCollectorRegistry,
): Hono<{ Variables: { userId: string } }> {
  const app = new Hono<{ Variables: { userId: string } }>();

  // List agent instances for a given tenant
  app.get(
    "/agents",
    describeRoute({
      tags: ["Agents"],
      summary: "List agent instances",
      description:
        "Lists the deployable (non-personal) agent instances the caller has deployed in the given tenant. Requires a `tenantId` query parameter.",
      parameters: [
        {
          name: "tenantId",
          in: "query",
          required: true,
          description: "Tenant whose agent instances to list.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "Agent instances for the caller",
          content: {
            "application/json": { schema: resolver(AgentInstanceListResponse) },
          },
        },
        400: {
          description: "Missing tenantId query parameter",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        403: {
          description: "Caller is not a user principal of the tenant",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const tenantId = c.req.query("tenantId");
      if (!tenantId) {
        return c.json({ error: "tenantId query parameter required" }, 400);
      }

      const callerPrincipal = await db.query.principal.findFirst({
        where: and(
          eq(principal.tenantId, tenantId),
          eq(principal.kind, "user"),
          eq(principal.refId, userId),
        ),
      });

      if (!callerPrincipal) {
        return c.json({ error: "Forbidden" }, 403);
      }

      const personalTemplateKeys = AGENT_TEMPLATES.filter(
        (t) => t.kind === "personal",
      ).map((t) => t.key);
      const hubDb = db as unknown as HubDb;

      // Return only instances this user has deployed (via memberAgentInstance),
      // excluding personal-template instances (those surface in PersonalAgentChat).
      const callerMappings = await hubDb.query.memberAgentInstance.findMany({
        where: and(
          eq(memberAgentInstance.tenantId, tenantId),
          eq(memberAgentInstance.memberPrincipalId, callerPrincipal.id),
          personalTemplateKeys.length > 0
            ? notInArray(memberAgentInstance.templateKey, personalTemplateKeys)
            : undefined,
        ),
      });

      const callerInstanceIds = callerMappings.map((m) => m.instanceId);
      if (callerInstanceIds.length === 0) {
        return c.json({ data: [] });
      }

      const sharedInstances = await db.query.agentInstance.findMany({
        where: and(
          inArray(agentInstance.id, callerInstanceIds),
          inArray(agentInstance.status, ["deployed", "running", "stopped"]),
          isNull(agentInstance.endedAt),
        ),
      });

      const agentIds = [...new Set(sharedInstances.map((i) => i.agentId))];
      const agentRows =
        agentIds.length > 0
          ? await db.query.agent.findMany({
              where: inArray(agent.id, agentIds),
            })
          : [];
      const agentMap = new Map(agentRows.map((a) => [a.id, a]));

      const result = sharedInstances.map((inst) => {
        const agentRow = agentMap.get(inst.agentId);
        return {
          id: inst.id,
          agentId: inst.agentId,
          agentName: agentRow?.name ?? "Unknown",
          agentDescription: agentRow?.description ?? null,
          tenantId: inst.tenantId,
          address: inst.address,
          status: inst.status,
          credentialRequirements: (agentRow?.credentialRequirements ?? []) as {
            providerName: string;
            source: string;
            name?: string;
          }[],
          capabilities: (agentRow?.capabilities ?? null) as Record<
            string,
            unknown
          > | null,
          createdAt: inst.createdAt.toISOString(),
        };
      });

      return c.json({ data: result });
    },
  );

  app.delete(
    "/tenants/:tenantId/agents/instances/:instanceId",
    describeRoute({
      tags: ["Agents"],
      summary: "Delete an agent instance",
      description:
        "Stops the agent instance, removes its member mapping, and tears down the sidecar session. With `?hard=true` the agent_instance row itself is removed (cascading inference turns and session assets); the hard path is restricted to ephemeral workflow instances (ids prefixed `ins_ses_`) so user chat history is never destroyed.",
      parameters: [
        {
          name: "tenantId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
        {
          name: "instanceId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
        {
          name: "hard",
          in: "query",
          required: false,
          description:
            "When `true`, hard-delete the row instead of marking it stopped. Only permitted for ephemeral workflow instances (`ins_ses_` ids).",
          schema: { type: "string", enum: ["true", "false"] },
        },
      ],
      responses: {
        204: { description: "Instance stopped and torn down" },
        400: {
          description: "Hard delete requested for a non-ephemeral instance",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        403: {
          description: "Caller is not a user principal of the tenant",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "Agent instance not found in the tenant",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const tenantId = c.req.param("tenantId");
      const instanceId = c.req.param("instanceId");
      const hard = c.req.query("hard") === "true";

      // Hard delete CASCADE-removes inference_turn (chat history). Only the
      // ephemeral workflow step/supervisor instances are throwaway; user chat
      // agents (Myra/Oat) must keep their history, so refuse the hard path for
      // anything that is not an `ins_ses_` instance.
      if (hard && !isEphemeralWorkflowInstance(instanceId)) {
        return c.json(
          {
            error:
              "Hard delete is only permitted for ephemeral workflow instances (ins_ses_ ids)",
          },
          400,
        );
      }

      const callerPrincipal = await db.query.principal.findFirst({
        where: and(
          eq(principal.tenantId, tenantId),
          eq(principal.kind, "user"),
          eq(principal.refId, userId),
        ),
      });
      if (!callerPrincipal) return c.json({ error: "Forbidden" }, 403);

      const instance = await db.query.agentInstance.findFirst({
        where: and(
          eq(agentInstance.id, instanceId),
          eq(agentInstance.tenantId, tenantId),
        ),
      });
      if (!instance) return c.json({ error: "Agent instance not found" }, 404);

      const now = new Date();
      await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as DB["db"];
        const hubTx = tx as unknown as HubDb;
        // Remove any personal-agent mapping so /me returns paInstanceId: null,
        // which surfaces the onboarding screen (re-deploy) rather than a broken
        // "provisioning" state. The mapping is hub-owned (no FK to
        // agent_instance), so it is deleted explicitly in both paths.
        await hubTx
          .delete(memberAgentInstance)
          .where(eq(memberAgentInstance.instanceId, instanceId));
        if (hard) {
          // Drop the row outright. Postgres FK cascades clean up the dependent
          // rows: inference_turn (CASCADE), session_asset (CASCADE), and
          // session_mail.instanceId (SET NULL). This is what lets the cleanup
          // script converge — a soft stop leaves the row for the admin list to
          // re-surface forever.
          await tx
            .delete(agentInstance)
            .where(eq(agentInstance.id, instanceId));
        } else {
          await tx
            .update(agentInstance)
            .set({ status: "stopped", endedAt: now, updatedAt: now })
            .where(eq(agentInstance.id, instanceId));
        }
      });

      // Notify the sidecar so it tears down the agent immediately. Without this,
      // the sidecar holds the agent in memory and will try to re-register it on
      // reconnect, failing challenge because endedAt is now set in the DB.
      await sessionService
        .endSession(instance.address, "user deleted instance")
        .catch((err) => {
          log.warn("Failed to end sidecar session on instance delete", {
            instanceId,
            error: err instanceof Error ? err.message : String(err),
          });
        });

      return c.body(null, 204);
    },
  );

  // Abort the in-flight chat turn for an instance the caller can manage.
  //
  // BEHAVIOR CHANGE (runtime retirement): the workbench's `user_stop_turn`
  // non-terminal abort rode on the `session.abort` frame, which Interchange
  // deleted when it retired the in-process session runtime. A single-agent
  // instance now runs as a supervised workflow-process child, and the sidecar
  // exposes no turn-cancel transport for it (SidecarRouter has undeploy, drain,
  // signal-deliver, and sources-update — no per-turn abort). Until a
  // workflow-child cancel path is wired, the endpoint cannot stop a running
  // turn; it fails closed with 409 rather than silently pretending success.
  // The auth/ownership checks are preserved so the contract (and its tests)
  // stay meaningful for when the transport returns.
  app.post(
    "/instances/:instanceId/abort-turn",
    describeRoute({
      tags: ["Agents"],
      summary: "Abort the running chat turn",
      description:
        "Stops the instance's in-flight turn (inference or tool execution) without ending the conversation. Requires a manage grant on the instance. The session stays usable; the next message resumes it.",
      parameters: [
        {
          name: "instanceId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        204: { description: "Turn aborted" },
        403: {
          description: "Caller lacks a manage grant on the instance",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description:
            "Instance not found, or caller is not a user principal of its tenant",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        409: {
          description: "No turn is currently running",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        502: {
          description: "Sidecar unavailable",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const instanceId = c.req.param("instanceId");

      const instance = await db.query.agentInstance.findFirst({
        where: eq(agentInstance.id, instanceId),
      });
      if (!instance) {
        return c.json({ error: "Instance not found" }, 404);
      }

      const callerPrincipal = await db.query.principal.findFirst({
        where: and(
          eq(principal.tenantId, instance.tenantId),
          eq(principal.kind, "user"),
          eq(principal.refId, userId),
        ),
      });
      if (!callerPrincipal) {
        // Identical to the not-found case so instance ids in other tenants
        // cannot be enumerated (same contract as the session-launch route).
        return c.json({ error: "Instance not found" }, 404);
      }

      // The owning member is minted read/write/manage grants on the instance
      // at deploy time; manage is the abort action. collectGrants resolves
      // direct and role-inherited grants.
      const grants = await grantStore.collectGrants(
        callerPrincipal.id,
        instance.tenantId,
      );
      const resource = `instance:${instanceId}`;
      const canManage = grants.some(
        (g) =>
          g.effect === "allow" &&
          matchPattern(g.resource, resource) &&
          matchPattern(g.action, "manage"),
      );
      if (!canManage) {
        return c.json({ error: "Forbidden" }, 403);
      }

      log.warn("Turn abort requested but unsupported in the workflow runtime", {
        instanceId,
        tenantId: instance.tenantId,
        userId,
        principalId: callerPrincipal.id,
      });
      return c.json(
        { error: "Stopping a running turn is not available in this runtime" },
        409,
      );
    },
  );

  // Launch (or relaunch) a session for an agent instance.
  // Credentials are resolved via Interchange's credential-requirement resolution — no IDs needed.
  app.post(
    "/instances/:instanceId/sessions",
    describeRoute({
      tags: ["Agents"],
      summary: "Launch an agent session",
      description:
        "Launches (or relaunches) a session for an agent instance. Idempotent for an already-routable instance (refreshes grants without restarting). Credentials are resolved via Interchange credential-requirement resolution.",
      parameters: [
        {
          name: "instanceId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "Session launched or already live",
          content: {
            "application/json": { schema: resolver(LaunchSessionResponse) },
          },
        },
        404: {
          description:
            "Instance not found, or caller is not a user principal of its tenant",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        409: {
          description: "Instance was deleted and cannot be relaunched",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        500: {
          description: "Tenant or agent configuration missing",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        503: {
          description: "Failed to launch the agent session",
          content: {
            "application/json": { schema: resolver(LaunchErrorResponse) },
          },
        },
      },
    }),
    async (c) => {
      const routeStart = performance.now();
      const userId = c.get("userId");
      const instanceId = c.req.param("instanceId");

      let pageContext: string | undefined;
      const rawBody = await c.req.json().catch(() => undefined);
      if (rawBody !== undefined) {
        const parsed = LaunchSessionRequest(rawBody);
        if (parsed instanceof type.errors) {
          return c.json({ error: "Invalid launch session request" }, 400);
        }
        pageContext = parsed.pageContext;
      }

      const instance = await db.query.agentInstance.findFirst({
        where: eq(agentInstance.id, instanceId),
      });
      if (!instance) {
        return c.json({ error: "Instance not found" }, 404);
      }

      const callerPrincipal = await db.query.principal.findFirst({
        where: and(
          eq(principal.tenantId, instance.tenantId),
          eq(principal.kind, "user"),
          eq(principal.refId, userId),
        ),
      });
      if (!callerPrincipal) {
        // Return 404 (identical to the not-found case) so a caller cannot
        // enumerate valid instance IDs that exist in another tenant.
        return c.json({ error: "Instance not found" }, 404);
      }

      // If the agent is already reachable on a connected sidecar, it is live — do
      // not re-launch. Re-launching re-deploys the same address, which the sidecar
      // rejects with "Agent already exists"; that rejected deploy evicts the live
      // agent from the router address index, after which mail 502s with "agent is
      // unreachable". The frontend fires this route proactively (and sometimes
      // twice) right after deploy, so it must be idempotent for a healthy
      // instance. The 409-recovery path still works: a genuinely-down instance is
      // not routable, so it falls through to relaunch below.
      //
      // Even when already routable, refresh DB grants and push them to the sidecar.
      // After a hub redeploy the sidecar reconnects and the orchestrator pushes
      // whatever grants are currently in the DB — which may be stale if tool names
      // changed (e.g. short→canonical on M4). Idempotent: delete+reinsert is safe
      // on every call and sendGrantsUpdate does not restart the agent.
      if (sidecarRouter.getRoutableAddresses().includes(instance.address)) {
        const grantsStart = performance.now();
        await refreshInstanceGrantsFromDefinition(
          db,
          {
            agentId: instance.agentId,
            tenantId: instance.tenantId,
            principalId: instance.principalId,
            address: instance.address,
            instanceId,
          },
          { sidecarRouter, grantStore },
        );
        log.info("Warm-path session launch", {
          instanceId,
          grantsRefreshMs: performance.now() - grantsStart,
          totalMs: performance.now() - routeStart,
        });
        // Steady-state path for a live Myra instance (reload / reopen / proactive
        // launch). Still return sessionId so ReviewGate can stay chat-scoped
        // rather than falling open to the whole tenant (CL-3286).
        return c.json({
          launched: true,
          sessionId: instance.sessionId ?? null,
        });
      }

      // A stopped instance with endedAt set was explicitly deleted — it cannot be
      // relaunched. The caller should provision a fresh instance instead.
      if (instance.status === "stopped" && instance.endedAt !== null) {
        return c.json(
          { error: "Instance was deleted. Provision a new instance." },
          409,
        );
      }

      // Reset a stopped instance so the sidecar treats it as a fresh launch.
      if (instance.status === "stopped") {
        const resetNow = new Date();
        await db
          .update(agentInstance)
          .set({ status: "deployed", endedAt: null, updatedAt: resetNow })
          .where(eq(agentInstance.id, instanceId));
      }

      const tenantRow = await db.query.tenant.findFirst({
        where: eq(tenant.id, instance.tenantId),
      });
      if (!tenantRow?.domain) {
        return c.json({ error: "Tenant configuration missing" }, 500);
      }

      const agentRow = await db.query.agent.findFirst({
        where: eq(agent.id, instance.agentId),
      });
      if (!agentRow?.systemPrompt) {
        return c.json({ error: "Agent configuration missing" }, 500);
      }

      const now = new Date();
      // Capture the narrowed value: the guard above proved systemPrompt is a
      // string, but that narrowing is lost inside the launch closure below,
      // which would widen it back to `string | null`.
      const systemPrompt = agentRow.systemPrompt;

      let launched = false;
      let sessionId: string | null = null;
      let launchFailure: LaunchErrorDescription | undefined;

      const launchStart = performance.now();
      try {
        // Coalesce concurrent POSTs for the same instance onto one launch: the
        // frontend fires this route proactively and sometimes twice, and two
        // launches racing here let the loser's failure teardown delete the
        // instance row mid-ack of the winner (503 phase=provision).
        const result = await coalesceInstanceLaunch(instanceId, () =>
          launchAgentSession(db, sessionService, grantStore, eventCollectors, {
            agentId: instance.agentId,
            instanceId: instance.id,
            instancePrincipalId: instance.principalId,
            tenantId: instance.tenantId,
            tenantDomain: tenantRow.domain,
            systemPrompt,
            now,
            ...(pageContext !== undefined ? { pageContext } : {}),
          }),
        );
        sessionId = result.sessionId;
        launched = true;
        log.info("Cold-path session launch", {
          instanceId,
          launchMs: performance.now() - launchStart,
          totalMs: performance.now() - routeStart,
        });
      } catch (err) {
        // If the sidecar already has the agent provisioned (e.g. a race between
        // the orchestrator's reconnect path and this explicit launch), treat it
        // as success. The agent is live; the frontend can proceed.
        if (isAgentAlreadyExistsError(err)) {
          await db
            .update(agentInstance)
            .set({ status: "running", updatedAt: new Date() })
            .where(eq(agentInstance.id, instanceId));
          // launchAgentSession threw after minting/resuming the session row —
          // re-read so the client can still scope ReviewGate to this session.
          const refreshed = await db.query.agentInstance.findFirst({
            where: eq(agentInstance.id, instanceId),
          });
          sessionId = refreshed?.sessionId ?? instance.sessionId ?? null;
          launched = true;
        } else {
          launchFailure = describeLaunchError(err);
          // Log the real Error object (not a pre-stringified message) so the
          // Sentry sink routes it through captureException with stack + cause,
          // and surface the SessionLaunchError phase + cause detail.
          log.error(
            launchFailureLogMessage(
              "Failed to launch agent session",
              launchFailure,
            ),
            {
              instanceId,
              phase: launchFailure.phase,
              detail: launchFailure.detail,
              error: err instanceof Error ? err : new Error(String(err)),
            },
          );
        }
      }

      if (!launched) {
        const failure = launchFailure ?? {
          phase: null,
          detail: "Failed to launch agent session",
        };
        return c.json(
          {
            error: "Failed to launch agent session",
            phase: failure.phase,
            detail: failure.detail,
          },
          503,
        );
      }

      // sessionId lets the client scope Action Requests to this chat session
      // (CL-3286) instead of showing every pending approval in the tenant.
      return c.json({ launched: true, sessionId });
    },
  );

  // List deployable agent templates for the catalog UI.
  app.get(
    "/agents/templates",
    describeRoute({
      tags: ["Agents"],
      summary: "List agent templates",
      description:
        "Lists the deployable (non-personal) agent templates available for the catalog.",
      responses: {
        200: {
          description: "Deployable agent templates",
          content: {
            "application/json": { schema: resolver(AgentTemplateListResponse) },
          },
        },
      },
    }),
    (c) => {
      const templates = AGENT_TEMPLATES.filter(
        (t) => t.deployable !== false && t.kind !== "personal",
      ).map((t) => ({
        key: t.key,
        name: t.name,
        description: t.description,
        tools: t.capabilities.tools,
      }));
      return c.json({ data: templates });
    },
  );

  // Deploy an agent instance from a pre-built template.
  // Creates a principal + agentInstance + memberAgentInstance row then launches
  // the session. The shared agent definition is the one seeded at boot time in
  // the global org tenant.
  app.post(
    "/tenants/:tenantId/agents/instances",
    describeRoute({
      tags: ["Agents"],
      summary: "Deploy an agent instance from a template",
      description:
        "Creates a principal, agent instance, member mapping, and owner grants from a deployable template, then launches the session. The agent definition is resolved by walking up the tenant hierarchy.",
      parameters: [
        {
          name: "tenantId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: {
        content: {
          "application/json": {
            schema: requestBodySchema(CreateInstanceRequest),
          },
        },
      },
      responses: {
        201: {
          description: "Agent instance created",
          content: {
            "application/json": { schema: resolver(CreateInstanceResponse) },
          },
        },
        400: {
          description: "Missing templateKey or unknown/non-deployable template",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        403: {
          description: "Caller is not a user principal of the tenant",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description:
            "Agent definition for the template not found in the hierarchy",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        500: {
          description: "Tenant configuration missing",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        503: {
          description:
            "Failed to launch the agent session (instance rolled back)",
          content: {
            "application/json": { schema: resolver(LaunchErrorResponse) },
          },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const tenantId = c.req.param("tenantId");

      const callerPrincipal = await db.query.principal.findFirst({
        where: and(
          eq(principal.tenantId, tenantId),
          eq(principal.kind, "user"),
          eq(principal.refId, userId),
        ),
      });
      if (!callerPrincipal) return c.json({ error: "Forbidden" }, 403);

      const body = (await c.req.json().catch(() => ({}))) as {
        templateKey?: unknown;
      };
      const templateKey =
        typeof body.templateKey === "string" ? body.templateKey : "";
      if (!templateKey)
        return c.json({ error: "templateKey is required" }, 400);

      const template = AGENT_TEMPLATES.find((t) => t.key === templateKey);
      if (!template || template.deployable === false) {
        return c.json({ error: "Unknown or non-deployable template" }, 400);
      }

      const tenantRow = await db.query.tenant.findFirst({
        where: eq(tenant.id, tenantId),
      });
      if (!tenantRow?.domain)
        return c.json({ error: "Tenant configuration missing" }, 500);

      // Walk up the tenant hierarchy until we find the agent definition or exhaust the tree.
      // Start from tenantRow.parentId — tenantRow is already fetched and checked above.
      // Cycle guard prevents infinite loops on malformed tenant data.
      const findDefInHierarchy = async (startTenantId: string) => {
        const visited = new Set<string>();
        let cursor: string | null = startTenantId;
        while (cursor !== null) {
          if (visited.has(cursor)) break;
          visited.add(cursor);
          const candidate = await db.query.agent.findFirst({
            where: and(
              eq(agent.tenantId, cursor),
              eq(agent.name, template.name),
            ),
          });
          if (candidate) return candidate;
          const tenantResult: { parentId: string | null } | undefined =
            await db.query.tenant.findFirst({ where: eq(tenant.id, cursor) });
          cursor = tenantResult?.parentId ?? null;
        }
        return undefined;
      };
      const def = await findDefInHierarchy(tenantRow.parentId ?? tenantId);
      if (!def) {
        return c.json(
          { error: `Agent definition for template "${templateKey}" not found` },
          404,
        );
      }

      const hubDb = db as unknown as HubDb;

      const now = new Date();
      const instanceId = generateId("instance");
      let instancePrincipalId = "";

      await hubDb.transaction(async (rawTx) => {
        const tx = rawTx as unknown as HubDb;

        // Each instance gets its own principal scoped to the user's workbench tenant.
        // refId = instanceId keeps principals isolated per user — two users deploying
        // the same shared definition get separate principals.
        const newPrincipalId = generateId("principal");
        await tx.insert(principal).values({
          id: newPrincipalId,
          tenantId,
          kind: "agent",
          refId: instanceId,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });
        instancePrincipalId = newPrincipalId;

        await tx.insert(agentInstance).values({
          id: instanceId,
          agentId: def.id,
          tenantId,
          principalId: instancePrincipalId,
          address: `${instanceId}@${tenantRow.domain}`,
          status: "deployed",
          createdAt: now,
          updatedAt: now,
        });

        await tx.insert(memberAgentInstance).values({
          id: generateId("instance"),
          tenantId,
          memberPrincipalId: callerPrincipal.id,
          templateKey,
          agentId: def.id,
          instanceId,
          createdAt: now,
        });

        // The owning member needs principal-scoped grants to operate their own
        // instance: read powers the chat event stream (`GET /instances/:id/events`),
        // write sends mail, manage aborts a turn. Without these the catalog-deploy
        // path leaves the instance unreadable to its creator (403 "no_match"),
        // matching the provisioning-on-join path in tenant-provisioning (CL-1635).
        for (const action of ["read", "write", "manage"] as const) {
          await tx.insert(grant).values({
            id: generateId("grant"),
            tenantId,
            principalId: callerPrincipal.id,
            resource: `instance:${instanceId}`,
            action,
            effect: "allow",
            origin: "system",
            createdAt: now,
            updatedAt: now,
          });
        }
      });

      try {
        await launchAgentSession(
          db,
          sessionService,
          grantStore,
          eventCollectors,
          {
            agentId: def.id,
            instanceId,
            instancePrincipalId,
            tenantId,
            tenantDomain: tenantRow.domain,
            systemPrompt: def.systemPrompt ?? "",
            now,
          },
        );
      } catch (err) {
        // A race between the orchestrator's reconnect path and this explicit
        // launch can report the agent as already provisioned. The agent is
        // live, so keep the instance and treat it as a successful deploy —
        // tearing it down here would delete a healthy instance.
        if (!isAgentAlreadyExistsError(err)) {
          const failure = describeLaunchError(err);
          // A leaked agent means the sidecar's own undeploy also failed, so a
          // provisioned agent survives on the sidecar with no way for the hub to
          // reach it. Deleting the hub rows here would orphan that zombie: the
          // address keeps routing on the sidecar but has no hub row, so the next
          // mail 502s until a sidecar restart. Keep the rows and mark the
          // instance 'error' so relaunchInstanceIfNeeded (which acts on a cold
          // start — no active session — and only skips a 'stopped'+endedAt
          // instance) re-attempts the launch and the sidecar's
          // already-exists carve-out adopts the live agent. (CL-2367)
          if (failure.leakedAgent) {
            log.error(
              launchFailureLogMessage(
                "Agent instance created but session launch failed AND the sidecar leaked the agent; keeping rows",
                failure,
              ),
              {
                instanceId,
                phase: failure.phase,
                detail: failure.detail,
                leakedAgent: failure.leakedAgent,
                error: err instanceof Error ? err : new Error(String(err)),
              },
            );
            const now2 = new Date();
            await hubDb
              .update(agentInstance)
              .set({ status: "error", updatedAt: now2 })
              .where(eq(agentInstance.id, instanceId));
            return c.json(
              {
                error: "Failed to launch agent session",
                phase: failure.phase,
                detail: failure.detail,
                leakedAgent: failure.leakedAgent,
              },
              503,
            );
          }
          // Log the real Error at error level so the Sentry sink reports it via
          // captureException with stack + cause (not a stringified captureMessage).
          log.error(
            launchFailureLogMessage(
              "Agent instance created but session launch failed; tearing down instance",
              failure,
            ),
            {
              instanceId,
              phase: failure.phase,
              detail: failure.detail,
              leakedAgent: failure.leakedAgent,
              error: err instanceof Error ? err : new Error(String(err)),
            },
          );
          // Do not leave an orphan instance that looks healthy (status 'deployed',
          // a member mapping, owner grants) but never launched and cannot serve
          // chat. Roll back the rows we just created and fail loudly so the caller
          // does not get a 201 for a dead instance.
          // FK-dictated order: agentInstance.sessionId → agentSession and
          // agentSession.principalId → principal are both RESTRICT, and
          // launchAgentSession leaves the session row behind (marked 'ended', not
          // deleted) on a failed launch. Delete instance → session → principal so
          // the principal delete does not FK-violate and abort the rollback.
          await hubDb.transaction(async (rawTx) => {
            const tx = rawTx as unknown as HubDb;
            await tx
              .delete(grant)
              .where(eq(grant.resource, `instance:${instanceId}`));
            await tx
              .delete(memberAgentInstance)
              .where(eq(memberAgentInstance.instanceId, instanceId));
            await tx
              .delete(agentInstance)
              .where(eq(agentInstance.id, instanceId));
            await tx
              .delete(agentSession)
              .where(eq(agentSession.principalId, instancePrincipalId));
            await tx
              .delete(principal)
              .where(
                and(
                  eq(principal.refId, instanceId),
                  eq(principal.kind, "agent"),
                ),
              );
          });
          return c.json(
            {
              error: "Failed to launch agent session",
              phase: failure.phase,
              detail: failure.detail,
              leakedAgent: failure.leakedAgent,
            },
            503,
          );
        }
      }

      return c.json({ instanceId, created: true }, 201);
    },
  );

  // Reconcile every member instance's tool + requirement grants for a template
  // to the current org definition, pushing fresh grants to any live sidecar.
  // The boot reseed only updates the org agent row; existing members keep the
  // grants from their last launch (provisionMemberInstances skips them), so a
  // newly-added tool surfaces as "No matching grants" until a relaunch. This is
  // the in-process, no-restart remedy operators run without redeploying.
  app.post(
    "/admin/templates/:templateKey/reconcile-grants",
    describeRoute({
      tags: ["Agents"],
      summary: "Reconcile member instance grants for a template",
      description:
        "Rewrites every member instance's tool/requirement grants to the current org definition and pushes them to live sidecars without restarting. Caller must be a user principal of the global tenant.",
      parameters: [
        {
          name: "templateKey",
          in: "path",
          required: true,
          description: 'Template key to reconcile (e.g. "myra").',
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "Reconciliation counts",
          content: {
            "application/json": { schema: resolver(ReconcileGrantsResponse) },
          },
        },
        403: {
          description: "Caller is not a user principal of the global tenant",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "Unknown template key",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const templateKey = c.req.param("templateKey");

      const template = AGENT_TEMPLATES.find((t) => t.key === templateKey);
      if (!template) {
        return c.json({ error: `Unknown template key: ${templateKey}` }, 404);
      }

      const rootTenantId = await getRootTenantId(db);
      if (!rootTenantId) {
        return c.json({ error: "Root tenant not seeded" }, 403);
      }

      const member = await lookupMember(db, { tenantId: rootTenantId, userId });
      if (!member) {
        return c.json({ error: "Forbidden" }, 403);
      }

      const [result] = await reconcileMemberInstanceGrants(
        db,
        rootTenantId,
        [template],
        { sidecarRouter, grantStore },
      );
      return c.json(
        result ?? { templateKey, reconciled: 0, pushed: 0, skipped: 0 },
      );
    },
  );

  return app;
}
