import { randomUUID } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { getLogger } from "@intx/log";
import type {
  EventCollectorRegistry,
  SessionService,
} from "@intx/hub-sessions";
import type { GrantStore } from "@intx/types/authz";
import type { CryptoProvider } from "@intx/types/runtime";
import type { TurnFinalized } from "@workbench/event-collector";
import type { HubDb } from "../db";
import { agentInstance, memberAgentInstance } from "../db/schema";
import { loadWorkflowGateInfos } from "../lib/workflow-catalog";
import {
  kindAllowsScheduledPostIntakeDrive,
  type WorkflowGateInfo,
} from "../lib/workflow-gate-info";
import { isFeatureEnabledForTenantCached } from "../lib/feature-grants";
import { slidingWindowLimiter } from "../lib/sliding-window";
import {
  postIntakeGatesForScheduledDrive,
  SCHEDULED_GATE_TEMPLATE_KEY,
} from "./scheduled-gate-targets";
import { describePendingGates } from "../workflow-executor/pending-gate-info";
import type { AwaitingRunContext } from "../workflow-executor/gate-mail";
import { deliverRunTerminalMail } from "../workflow-executor/run-terminal-mail";
import { loadRunRecord, setRunStatus } from "../workflow-executor/run-store";
import { launchAgentSession } from "./agent-provisioning";
import { resolveMyraDefinition, teardownThreadRows } from "./myra-threads";
import type { RepoStore } from "@intx/hub-sessions";

const log = getLogger(["services", "scheduled-workflow-gate-agent"]);

export { SCHEDULED_GATE_TEMPLATE_KEY, postIntakeGatesForScheduledDrive } from "./scheduled-gate-targets";

const DEFAULT_TURN_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TURNS = 4;
const MAX_QUEUE = 32;
const MAX_SESSIONS_PER_HOUR = 40;
const SESSION_WINDOW_MS = 60 * 60 * 1000;

const SCHEDULED_GATE_TOOL_NAMES = ["workflow_list_runs", "workflow_signal"] as const;

const SCHEDULED_GATE_SYSTEM_PROMPT = `You are completing a scheduled (unattended) workflow run for the run owner.
The run is parked on a workflow gate. Your only job is to resolve that gate.

Steps:
1. Call workflow_list_runs and find the run by runId (given in the user message).
2. Read pendingGates for that run — use the exact signalName listed there.
3. Call workflow_signal with that runId, signalName, and a minimal valid payload (use {} when the gate has no required fields).
4. Do not start new workflows, mail anyone, or take any action outside workflow_signal.

If you cannot resolve the gate within this turn, say SCHEDULED_GATE_FAILED and why.`;

export type ScheduledGateDriveArgs = {
  runId: string;
  kind: string;
  tenantId: string;
  principalId: string;
  deploymentId: string;
  signalName: string;
  deploymentDomain: string;
  repoStore: RepoStore;
};

/** Test seam: when set, replaces the live Myra ephemeral session (CL-3528). */
export type ScheduledGateDriverFn = (
  args: ScheduledGateDriveArgs,
) => Promise<{ ok: true } | { ok: false; error: string }>;

export type ScheduledWorkflowGateAgentDeps = {
  db: HubDb;
  sessionService: SessionService;
  grantStore: GrantStore;
  eventCollectors: EventCollectorRegistry;
  cryptoProvider: CryptoProvider;
  deploymentDomain: string;
  schedulerFeatureDefaultEnabled: boolean;
  turnTimeoutMs?: number;
  maxTurns?: number;
  driveGate?: ScheduledGateDriverFn;
  /** Test seam: override the in-memory drive queue cap (default 32). */
  maxQueue?: number;
  now?: () => number;
};

export type ScheduledWorkflowGateAgent = {
  maybeEnqueue: (args: AwaitingRunContext & { repoStore: RepoStore }) => void;
  handleTurnFinalized: (agentAddress: string, turn: TurnFinalized) => void;
  waitForDrain: () => Promise<void>;
};

type QueueItem = ScheduledGateDriveArgs & { attempt: number };

const { principal, agentInstance, tenant } = intxSchema;

export function createScheduledWorkflowGateAgent(
  deps: ScheduledWorkflowGateAgentDeps,
): ScheduledWorkflowGateAgent {
  const turnTimeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const maxTurns = deps.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxQueue = deps.maxQueue ?? MAX_QUEUE;
  const queue: QueueItem[] = [];
  const inFlight = new Set<string>();
  const pendingTurns = new Map<
    string,
    (turn: TurnFinalized | null) => void
  >();
  let processing = false;
  let drainWaiters: Array<() => void> = [];

  const sessionBudget = slidingWindowLimiter(
    MAX_SESSIONS_PER_HOUR,
    SESSION_WINDOW_MS,
    deps.now ?? Date.now,
  );

  async function isTenantEnabled(tenantId: string): Promise<boolean> {
    return isFeatureEnabledForTenantCached(
      deps.db,
      tenantId,
      "scheduler",
      deps.schedulerFeatureDefaultEnabled,
    );
  }

  function queueKey(args: { runId: string; signalName: string }): string {
    return `${args.runId}:${args.signalName}`;
  }

  function notifyDrain(): void {
    if (queue.length === 0 && inFlight.size === 0) {
      for (const resolve of drainWaiters) resolve();
      drainWaiters = [];
    }
  }

  function awaitTurn(agentAddress: string): Promise<TurnFinalized | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingTurns.delete(agentAddress);
        resolve(null);
      }, turnTimeoutMs);
      pendingTurns.set(agentAddress, (turn) => {
        clearTimeout(timer);
        pendingTurns.delete(agentAddress);
        resolve(turn);
      });
    });
  }

  async function failRun(
    args: ScheduledGateDriveArgs,
    message: string,
  ): Promise<void> {
    await setRunStatus(deps.db, args.runId, "failed");
    await deliverRunTerminalMail(
      {
        db: deps.db,
        deploymentDomain: deps.deploymentDomain,
      },
      {
        runId: args.runId,
        kind: args.kind,
        tenantId: args.tenantId,
        principalId: args.principalId,
        deploymentId: args.deploymentId,
        status: "failed",
        error: message,
        failedSteps: [],
      },
    ).catch((err) => {
      log.error("scheduled gate agent: terminal mail failed", {
        runId: args.runId,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    });
  }

  async function gateStillOpen(args: ScheduledGateDriveArgs): Promise<boolean> {
    const gates = await describePendingGates(
      {
        repoStore: args.repoStore,
        deploymentDomain: deps.deploymentDomain,
      },
      {
        runId: args.runId,
        kind: args.kind,
        deploymentId: args.deploymentId,
      },
    );
    return gates.some((g) => g.signalName === args.signalName);
  }

  async function driveWithMyra(item: QueueItem): Promise<void> {
    if (deps.driveGate) {
      const result = await deps.driveGate(item);
      if (!result.ok) {
        await failRun(item, result.error);
      }
      return;
    }

    const def = await resolveMyraDefinition(deps.db, item.tenantId);
    if (!def) {
      await failRun(
        item,
        "Scheduled gate drive failed: Myra definition unavailable",
      );
      return;
    }

    const tenantRow = await deps.db.query.tenant.findFirst({
      where: eq(tenant.id, item.tenantId),
    });
    if (!tenantRow?.domain) {
      await failRun(item, "Scheduled gate drive failed: tenant domain missing");
      return;
    }
    const tenantDomain = tenantRow.domain;

    if (!sessionBudget.tryAcquire(item.tenantId)) {
      await failRun(
        item,
        "Scheduled gate drive failed: session budget exceeded",
      );
      return;
    }

    const now = new Date();
    const instanceId = generateId("instance");
    const mappingId = generateId("instance");
    const instancePrincipalId = generateId("principal");

    await deps.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as HubDb;
      await tx.insert(principal).values({
        id: instancePrincipalId,
        tenantId: item.tenantId,
        kind: "agent",
        refId: instanceId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(agentInstance).values({
        id: instanceId,
        agentId: def.id,
        tenantId: item.tenantId,
        principalId: instancePrincipalId,
        address: `${instanceId}@${tenantDomain}`,
        status: "deployed",
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(memberAgentInstance).values({
        id: mappingId,
        tenantId: item.tenantId,
        memberPrincipalId: item.principalId,
        templateKey: SCHEDULED_GATE_TEMPLATE_KEY,
        agentId: def.id,
        instanceId,
        label: `Scheduled gate: ${item.signalName}`,
        createdAt: now,
        lastActivityAt: now,
      });
    });

    const userMessage = [
      "Complete the scheduled workflow gate.",
      "",
      `runId: ${item.runId}`,
      `kind: ${item.kind}`,
      `expectedGate: ${item.signalName}`,
      "",
      "Use workflow_list_runs then workflow_signal. Act only for this runId.",
    ].join("\n");

    let address: string | undefined;
    const teardownOpts = {
      instanceId,
      mappingId,
      instancePrincipalId,
    };
    try {
      const launched = await launchAgentSession(
        deps.db,
        deps.sessionService,
        deps.grantStore,
        deps.eventCollectors,
        {
          agentId: def.id,
          instanceId,
          instancePrincipalId,
          tenantId: item.tenantId,
          tenantDomain,
          systemPrompt: SCHEDULED_GATE_SYSTEM_PROMPT,
          persona: { toolNames: [...SCHEDULED_GATE_TOOL_NAMES] },
          now,
        },
      );
      address = launched.address;
      const turnPromise = awaitTurn(address);
      await deps.sessionService.sendUserMessage({
        agentAddress: address,
        from: `hub@${tenantDomain}`,
        messageId: randomUUID(),
        date: new Date(),
        content: userMessage,
        sessionId: launched.sessionId,
        tenantId: item.tenantId,
        cryptoProvider: deps.cryptoProvider,
      });
      const turn = await turnPromise;
      const failedText =
        turn === null ||
        turn.status !== "completed" ||
        (turn.text?.includes("SCHEDULED_GATE_FAILED") ?? false);
      const stillOpen = await gateStillOpen(item);
      if (failedText || stillOpen) {
        if (item.attempt < maxTurns) {
          queue.push({ ...item, attempt: item.attempt + 1 });
          return;
        }
        await failRun(
          item,
          stillOpen
            ? `Scheduled gate "${item.signalName}" was not cleared after ${maxTurns} attempt(s)`
            : "Scheduled gate drive turn failed or timed out",
        );
      }
    } catch (err) {
      log.error("scheduled gate agent: Myra session failed", {
        runId: item.runId,
        signalName: item.signalName,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      if (item.attempt < maxTurns) {
        queue.push({ ...item, attempt: item.attempt + 1 });
        return;
      }
      await failRun(
        item,
        err instanceof Error ? err.message : "Scheduled gate drive failed",
      );
    } finally {
      // Same teardown contract as mailbox-triage: undeploy the sidecar harness
      // before deleting hub rows, or leave rows for the boot sweep to retry.
      let sessionEnded = address === undefined;
      if (address !== undefined) {
        pendingTurns.delete(address);
        try {
          await deps.sessionService.endSession(address, "scheduled_gate_done");
          sessionEnded = true;
        } catch (err) {
          log.warn(
            "Scheduled gate session end failed; leaving instance for boot sweep",
            {
              instanceId,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }
      if (sessionEnded) {
        try {
          await teardownThreadRows(deps.db, teardownOpts);
        } catch (err) {
          log.error("Scheduled gate teardown failed for {instanceId}", {
            instanceId,
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }
    }
  }

  async function processQueue(): Promise<void> {
    if (processing) return;
    processing = true;
    try {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) break;
        const key = queueKey(item);
        if (inFlight.has(key)) continue;
        inFlight.add(key);
        try {
          await driveWithMyra(item);
        } finally {
          inFlight.delete(key);
        }
      }
    } finally {
      processing = false;
      notifyDrain();
      if (queue.length > 0) void processQueue();
    }
  }

  return {
    maybeEnqueue(args) {
      void (async () => {
        if (!(await isTenantEnabled(args.tenantId))) return;
        const record = await loadRunRecord(deps.db, args.runId);
        if (record?.triggerSource !== "scheduler") return;

        const gates = await describePendingGates(
          {
            repoStore: args.repoStore,
            deploymentDomain: deps.deploymentDomain,
          },
          {
            runId: args.runId,
            kind: args.kind,
            deploymentId: args.deploymentId,
          },
        );
        const targets = postIntakeGatesForScheduledDrive(
          record.triggerSource,
          gates,
        );
        if (targets.length > 0) {
          const gateInfos = await loadWorkflowGateInfos();
          const gateInfo: WorkflowGateInfo | undefined = gateInfos.get(
            args.kind,
          );
          if (
            gateInfo === undefined ||
            !kindAllowsScheduledPostIntakeDrive(args.kind, gateInfo)
          ) {
            log.warn(
              "scheduled gate agent: skipping drive for kind without post-intake allowance",
              { runId: args.runId, kind: args.kind },
            );
            return;
          }
        }
        for (const signalName of targets) {
          const key = queueKey({ runId: args.runId, signalName });
          if (inFlight.has(key)) continue;
          if (queue.some((q) => queueKey(q) === key)) continue;
          if (queue.length >= maxQueue) {
            log.warn("scheduled gate agent: queue full; failing run", {
              runId: args.runId,
              signalName,
              maxQueue,
            });
            await failRun(
              {
                runId: args.runId,
                kind: args.kind,
                tenantId: args.tenantId,
                principalId: args.principalId,
                deploymentId: args.deploymentId,
                signalName,
                deploymentDomain: deps.deploymentDomain,
                repoStore: args.repoStore,
              },
              "Scheduled gate drive failed: agent queue full",
            );
            continue;
          }
          queue.push({
            runId: args.runId,
            kind: args.kind,
            tenantId: args.tenantId,
            principalId: args.principalId,
            deploymentId: args.deploymentId,
            signalName,
            deploymentDomain: deps.deploymentDomain,
            repoStore: args.repoStore,
            attempt: 1,
          });
        }
        void processQueue();
      })().catch((err) => {
        log.error("scheduled gate agent: enqueue failed", {
          runId: args.runId,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      });
    },

    handleTurnFinalized(agentAddress, turn) {
      const waiter = pendingTurns.get(agentAddress);
      if (waiter) waiter(turn);
    },

    waitForDrain() {
      if (queue.length === 0 && inFlight.size === 0) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        drainWaiters.push(resolve);
      });
    },
  };
}

const SCHEDULED_GATE_SWEEP_STALE_MS = 30 * 60 * 1000;
const SCHEDULED_GATE_SWEEP_LIMIT = 500;

/**
 * Best-effort cleanup for myra-scheduled-gate instances left after a failed
 * endSession (mirrors mailbox-triage sweep).
 */
export async function sweepStaleScheduledGateInstances(
  db: HubDb,
  sessionService: Pick<SessionService, "endSession">,
  opts?: { staleAfterMs?: number; limit?: number; now?: () => number },
): Promise<{ scanned: number; retired: number }> {
  const staleAfterMs = opts?.staleAfterMs ?? SCHEDULED_GATE_SWEEP_STALE_MS;
  const limit = opts?.limit ?? SCHEDULED_GATE_SWEEP_LIMIT;
  const nowFn = opts?.now ?? (() => Date.now());
  const cutoff = new Date(nowFn() - staleAfterMs);

  const stale = await db
    .select({
      mappingId: memberAgentInstance.id,
      instanceId: memberAgentInstance.instanceId,
      instancePrincipalId: agentInstance.principalId,
      address: agentInstance.address,
    })
    .from(memberAgentInstance)
    .innerJoin(
      agentInstance,
      eq(memberAgentInstance.instanceId, agentInstance.id),
    )
    .where(
      and(
        eq(memberAgentInstance.templateKey, SCHEDULED_GATE_TEMPLATE_KEY),
        lt(memberAgentInstance.createdAt, cutoff),
      ),
    )
    .limit(limit);

  let retired = 0;
  for (const row of stale) {
    try {
      await sessionService.endSession(row.address, "scheduled_gate_boot_sweep");
    } catch {
      continue;
    }
    try {
      await teardownThreadRows(db, {
        instanceId: row.instanceId,
        mappingId: row.mappingId,
        instancePrincipalId: row.instancePrincipalId,
      });
      retired += 1;
    } catch {
      // best-effort
    }
  }

  return { scanned: stale.length, retired };
}