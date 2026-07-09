import { and, eq, gt, inArray, isNotNull, isNull, like } from "drizzle-orm";
import { deriveDeploymentAddress } from "@intx/workflow-deploy";
import { schema as intxSchema } from "@intx/db";
import { getLogger } from "@intx/log";
import type { SidecarRouter } from "@intx/hub-sessions";
import type { HubDb } from "../db";
import { workflowRun, workflowRunRecord } from "../db/schema";
import { loadRunRecord, setRunStatus } from "../workflow-executor/run-store";
import type { EnsureDeploymentRoutableFn } from "../routes/workflow-runs";
import type { ReclaimDeploymentFn } from "./workflow-deploy";

const log = getLogger(["services", "workflow-reconciler"]);

// Hub-as-control-plane reconciliation of workflow supervisor deployments.
//
// A multi-step supervisor's address lives only in the hub's in-memory
// addressIndex (set at deploy time) and is NOT re-advertised by the sidecar on
// register/reconnect — supervisors never run startSession, so they are absent
// from the sidecar's restorable-session set. The hub therefore loses every
// supervisor address on its own restart, and a sidecar restart tears down the
// supervisor child outright. The hub owns the source of truth (the workflow
// repo + DB rows), so it re-drives the supervisor deploy from that state rather
// than relying on the sidecar to restore itself.
//
// `ensureDeploymentRoutable` is idempotent and coalesced per deploymentId, so a
// reconcile pass is a cheap no-op for supervisors that are already routable.
//
// Caveats (documented honestly, not silently): (1) re-establishing a supervisor
// creates a live instance; under the "a deployed workflow has zero live
// instances" model these are transient and reaped by idle-harness eviction
// (CL-2219). (2) A run parked at an awaitSignal gate IS now resumable across a
// restart: CL-2535/2537 host-satisfies the resume — the sidecar self-discovers
// the parked run from disk and installs a live signal watcher that resumes it
// when the human signals. This reconciler re-establishes the supervisor so NEW
// runs work and so a parked run resumes end-to-end.
export interface WorkflowReconciler {
  // CL-2248: fail genuinely-interrupted `workflow_run_record` rows whose
  // supervisor is NOT routable. MUST be called on hub startup BEFORE
  // `reconcileAll()`, while the routable snapshot still reflects only sessions
  // the sidecar restored on its own — once `reconcileAll()` re-registers
  // supervisors, every run would look routable and nothing would be failed.
  //
  // CL-2575: only `running` (mid-execution) runs are failed. A run parked at an
  // awaitSignal gate (`awaiting`) is NOT failed — CL-2535/2537 made it resumable
  // across a restart (the sidecar self-discovers it and resumes on signal).
  // Failing an `awaiting` run flips its record terminal, which drops its
  // deployment out of `activeRunDeploymentIds`; the sidecar boot-reconciler then
  // reaps the deployment's `workflow-runs/<slug>` repo out from under the live
  // watcher, so the resume push ships a pack whose base is gone →
  // `pack_walk_dangling_parent` → `reason=corrupt`, retried forever (CL-2575).
  // Idempotent: already-terminal rows are not selected.
  failOrphanedRuns(): Promise<void>;
  // Re-establish supervisors for every per-run deployment that still has a
  // non-terminal run record (CL-2582: the per-run deploymentId lives on the
  // record, not on `workflow_run`). Run on hub startup and on sidecar reconnect.
  // Best-effort: a single deployment's failure is logged and never aborts the
  // pass.
  reconcileAll(): Promise<void>;
  // CL-2582 Step D (class 2): reclaim per-run deployments whose run reached a
  // terminal status but whose teardown did not fire (the hub crashed between the
  // projection-bridge save and the fire-and-forget teardown). Bounded to runs
  // that terminated recently and gated on the deployment STILL having live
  // instance rows, so it is a cheap no-op for the normal case where teardown
  // already ran. Run on hub startup after `reconcileAll`.
  reclaimOrphanedDeployments(): Promise<void>;
  // CL-2756: proactively re-establish the supervisor of every run PARKED at an
  // awaitSignal gate (`awaiting`) whose supervisor address is not currently
  // routable, so the human's gate-resume finds it already routable and pays NO
  // re-establish + child re-spawn on the critical path. This is the PERIODIC
  // backstop for the reconnect-driven `reconcileAll` (which fires only on
  // `agent.reconnected`): a sidecar that restarts and restores no sessions — an
  // all-inline/deterministic deployment, or a missed reconnect event — emits no
  // `agent.reconnected`, so nothing re-establishes the parked supervisor until
  // the resume itself does. Strictly awaiting-scoped: a `running` run is NEVER
  // pre-warmed here (a running run that lost its supervisor is failed by the
  // liveness sweep, not resurrected — resurrecting it would reintroduce the
  // churn the per-run/eviction model exists to prevent). Idempotent and
  // coalesced through `ensureDeploymentRoutable`; a failure is surfaced and
  // counted, never swallowed, and never aborts the batch.
  //
  // Hibernation of long-parked runs: the pre-warm applies only to runs
  // parked LESS than the hibernation grace. Past the grace the sweep flips
  // direction — a still-routable deployment is HIBERNATED (state-preserving
  // undeploy: child killed, workflow-run repo and step state kept) and an
  // unroutable one is left dormant; the gate signal's own
  // `ensureDeploymentRoutable` call re-establishes it exactly when the
  // resume needs it.
  reconcileAwaiting(): Promise<AwaitingPrewarmSummary>;
  // Subscribe to sidecar reconnect events and reconcile on each (coalesced to
  // one in-flight pass). Returns an unsubscribe handle.
  start(): () => void;
}

export interface AwaitingPrewarmSummary {
  // Unique awaiting deployments considered this pass.
  candidates: number;
  // Deployments the pass re-established (were unroutable, establish succeeded).
  reestablished: number;
  // Awaiting deployments already routable — skipped, no establish attempted.
  alreadyRoutable: number;
  // Awaiting deployments whose kind has no registry row to recover the deploy
  // principal from — cannot be revived, skipped.
  skippedNoPrincipal: number;
  // Establish/hibernate attempts that threw — surfaced (logged + counted),
  // batch continues.
  failed: number;
  // Routable deployments parked past the hibernation grace this pass tore
  // down (state-preserving hibernate undeploy sent and acked).
  hibernated: number;
  // Unroutable deployments parked past the hibernation grace left down —
  // wake is signal-driven (`ensureDeploymentRoutable` on the signal path),
  // never the pre-warm.
  dormant: number;
  // Durable pending signals re-delivered this pass (the 202-accepted signal's
  // first fire-and-forget delivery was lost or is not yet proven by the log).
  redelivered: number;
}

// Well-known `agent.undeploy` reason that selects the sidecar's
// state-PRESERVING teardown for a gate-parked run's deployment: the child
// subprocess and supervisor residency are freed while the workflow-run repo,
// step agent-state repos, and per-step scratch all survive for the
// signal-driven resume.
//
// PROTOCOL CONSTANT: `packages/hub-agent/src/ws/hub-link.ts` carries a
// byte-identical copy (`WORKFLOW_HIBERNATE_UNDEPLOY_REASON`) — the hub does
// not depend on that package, and the undeploy wire frame carries only
// `{ agentAddress, reason }`, so the hibernate flavor rides the reason
// string. Change both together or hibernation silently stops matching on
// one side.
export const WORKFLOW_HIBERNATE_UNDEPLOY_REASON =
  "workbench:hibernate-awaiting-run";

// How long a run may sit parked at an awaitSignal gate before its deployment
// is hibernated (child killed, durable state preserved). Also the pre-warm
// horizon: an unroutable awaiting run parked less than this is re-established
// (crash-recovery backstop); one parked longer stays down until a gate signal
// wakes it through `ensureDeploymentRoutable`. Mirrored by
// `WORKFLOW_HIBERNATION_GRACE_MS` in apps/hub/src/config.ts.
export const DEFAULT_WORKFLOW_HIBERNATION_GRACE_MS = 120_000;

// How long a durable pending signal may sit undelivered-by-the-log before the
// reconciler re-delivers it. Long enough for the ordinary path (deliver →
// child commits SignalReceived → pack push → projection clears the record) to
// complete; short enough that a lost signal wakes its run within a minute.
export const DEFAULT_SIGNAL_REDELIVERY_DELAY_MS = 30_000;

// How far back the orphan janitor looks for terminated-but-not-torn-down runs.
// A hub crash between the terminal save and the teardown is recovered on the
// next boot; 24h covers any realistic restart gap while keeping the scan small.
const ORPHAN_RECLAIM_WINDOW_MS = 24 * 60 * 60 * 1000;

export function createWorkflowReconciler(deps: {
  db: HubDb;
  events: SidecarRouter["events"];
  ensureDeploymentRoutable: EnsureDeploymentRoutableFn;
  getRoutableAddresses: SidecarRouter["getRoutableAddresses"];
  deploymentDomain: string;
  // CL-2582: tear a terminal run's orphaned deployment down (class 2 janitor).
  reclaimDeployment: ReclaimDeploymentFn;
  // Hibernation teardown sender. Bound to the sidecar router's
  // `sendAgentUndeploy` in index.ts; the reconciler sends it with the
  // hibernate reason marker so the sidecar preserves the parked run's state.
  sendAgentUndeploy: SidecarRouter["sendAgentUndeploy"];
  // Pending-signal re-delivery sender. Bound to the sidecar router's
  // `sendSignalDeliver` in index.ts; the reconciler re-delivers a durable
  // pending signal whose first (fire-and-forget) delivery was lost.
  sendSignalDeliver: SidecarRouter["sendSignalDeliver"];
  // Hibernation grace (ms). Optional with the exported default so tests and
  // direct constructors need not thread config; production wires the
  // env-validated `config.workflowHibernationGraceMs`.
  hibernationGraceMs?: number;
  // Minimum age (ms) of a pending signal before it is re-delivered, giving
  // the in-flight first delivery time to land and its SignalReceived to fold
  // (which clears the record). Optional with the exported default.
  signalRedeliveryDelayMs?: number;
}): WorkflowReconciler {
  const hibernationGraceMs =
    deps.hibernationGraceMs ?? DEFAULT_WORKFLOW_HIBERNATION_GRACE_MS;
  const signalRedeliveryDelayMs =
    deps.signalRedeliveryDelayMs ?? DEFAULT_SIGNAL_REDELIVERY_DELAY_MS;
  // Single-flight guard. A sidecar restart fires one agent.reconnected per
  // restored address, and the hub-startup pass can overlap any of them. The
  // guard lives in reconcileAll itself (not just the reconnect wrapper) so the
  // startup call and a reconnect-triggered call cannot run concurrent passes —
  // an overlapping trigger returns immediately and the in-flight pass covers it
  // (ensureDeploymentRoutable no-ops already-routable deployments). A trigger
  // arriving just after the flag clears starts a fresh pass, which is the
  // intended backstop behavior.
  let reconciling = false;

  async function failOrphanedRuns(): Promise<void> {
    // Snapshot the routable set BEFORE any re-registration. The safety
    // invariant: a run whose supervisor IS in this snapshot is never failed.
    const routable = new Set(deps.getRoutableAddresses());

    const stuckRuns = await deps.db
      .select({
        id: workflowRunRecord.id,
        deploymentId: workflowRunRecord.deploymentId,
        status: workflowRunRecord.status,
      })
      .from(workflowRunRecord)
      .where(
        and(
          // CL-2755: `provisioning` runs are swept too — a run seeded before its
          // deployment existed and stranded by a hub crash mid-provision has no
          // live supervisor and can never resume, so it must be failed like an
          // interrupted `running` run. `awaiting` is preserved (CL-2575).
          inArray(workflowRunRecord.status, [
            "provisioning",
            "running",
            "awaiting",
          ]),
          isNull(workflowRunRecord.deletedAt),
        ),
      );

    if (stuckRuns.length === 0) return;

    let failed = 0;
    let preservedParked = 0;
    for (const run of stuckRuns) {
      // CL-2575: this is THE resumability decision. A run parked at an
      // awaitSignal gate (`awaiting`) is resumable across a restart — CL-2535/
      // 2537 host-satisfies it (the sidecar self-discovers the parked run from
      // disk and resumes on signal). Failing it would flip its record terminal,
      // drop the deployment out of `activeRunDeploymentIds`, and let the sidecar
      // boot-reconciler reap the `workflow-runs/<slug>` repo out from under the
      // live watcher → the resume push ships a pack whose base is gone →
      // `pack_walk_dangling_parent` → `reason=corrupt`, retried forever. Only a
      // genuinely-interrupted `running` run is unrecoverable, so only it is
      // failed. (The query selects both statuses so this single in-loop branch
      // owns the decision and is unit-testable; awaiting runs are few.)
      // Only `awaiting` is resumable across a restart and preserved (CL-2575);
      // `running` and `provisioning` (CL-2755) are both failable when orphaned.
      if (run.status === "awaiting") {
        preservedParked += 1;
        continue;
      }
      // A run with no deployment can never have a routable supervisor, so it
      // is unconditionally orphaned by a restart. A `provisioning` run always
      // has a null deployment, so it falls straight through to the fail below.
      const supervisorAddress =
        run.deploymentId === null
          ? null
          : deriveDeploymentAddress({
              deploymentId: run.deploymentId,
              deploymentDomain: deps.deploymentDomain,
            });
      if (supervisorAddress !== null && routable.has(supervisorAddress))
        continue;

      try {
        // Mark the genuinely-interrupted run terminal. The failure REASON is no
        // longer persisted (the log is the source of truth for run detail,
        // CL-2669); the coarse `failed` status is the index signal.
        await setRunStatus(deps.db, run.id, "failed");
        failed += 1;
      } catch (err) {
        log.warn("failOrphanedRuns: failed to mark run failed", {
          runId: run.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (failed > 0 || preservedParked > 0) {
      log.info("failOrphanedRuns: marked interrupted runs failed", {
        candidates: stuckRuns.length,
        failed,
        // CL-2575: awaitSignal-parked runs left intact for the sidecar watcher
        // to resume — failing them would strand them with reason=corrupt.
        preservedParked,
      });
    }
  }

  async function reconcileAll(): Promise<void> {
    if (reconciling) return;
    reconciling = true;
    try {
      // Per-run deployment (CL-2582): a run's deployment id lives on its
      // `workflow_run_record`, NOT on `workflow_run` — a per-run deploy writes no
      // registry row. So re-establish supervisors by walking the NON-TERMINAL
      // records (the parked runs that must resume after a restart), not the
      // registry. The registry rows supply only the DEPLOY principal:
      // `ensureDeploymentRoutable` revives the supervisor's agent/instance rows
      // as that principal, but the record's `principalId` is the run OWNER, so we
      // recover the deployer from the kind's registry row (keyed by kind+tenant).
      //
      // A run whose record is terminal is never re-established (it needs no live
      // supervisor — that was the staging restart-loop resurrection vector). A
      // kind that has never run, or whose runs are all terminal, re-establishes
      // nothing — a new run self-provisions its own deployment at start.
      const registryRows = await deps.db
        .select({
          kind: workflowRun.kind,
          tenantId: workflowRun.tenantId,
          principalId: workflowRun.principalId,
        })
        .from(workflowRun)
        .where(
          and(
            isNotNull(workflowRun.deploymentId),
            isNull(workflowRun.deletedAt),
          ),
        );
      const deployPrincipalByKind = new Map<string, string>();
      for (const r of registryRows) {
        deployPrincipalByKind.set(`${r.kind} ${r.tenantId}`, r.principalId);
      }

      const activeRecords = await deps.db
        .select({
          deploymentId: workflowRunRecord.deploymentId,
          kind: workflowRunRecord.kind,
          tenantId: workflowRunRecord.tenantId,
          status: workflowRunRecord.status,
          updatedAt: workflowRunRecord.updatedAt,
        })
        .from(workflowRunRecord)
        .where(
          and(
            inArray(workflowRunRecord.status, ["running", "awaiting"]),
            isNotNull(workflowRunRecord.deploymentId),
            isNull(workflowRunRecord.deletedAt),
          ),
        );

      const seen = new Set<string>();
      const now = Date.now();
      let reestablished = 0;
      let skippedNoPrincipal = 0;
      let dormant = 0;
      for (const rec of activeRecords) {
        if (rec.deploymentId === null || seen.has(rec.deploymentId)) continue;
        seen.add(rec.deploymentId);
        // A run parked at a gate past the hibernation grace stays down across
        // reconnect passes — re-establishing it here would resurrect the
        // child the hibernation sweep just killed. Wake is signal-driven:
        // the signal path's `ensureDeploymentRoutable` re-establishes it
        // exactly when the gate resume needs it. A parked run's record is
        // written only when its run log advances, so `updatedAt` is the
        // park time (the last fold is SignalAwaited).
        if (
          rec.status === "awaiting" &&
          now - rec.updatedAt.getTime() >= hibernationGraceMs
        ) {
          dormant += 1;
          continue;
        }
        const deployPrincipal = deployPrincipalByKind.get(
          `${rec.kind} ${rec.tenantId}`,
        );
        if (deployPrincipal === undefined) {
          // The kind was undeployed since the run started — no registry row to
          // recover the deploy principal from, so the supervisor can't be
          // revived. Leave it (the run can't resume against a gone definition).
          skippedNoPrincipal += 1;
          continue;
        }
        try {
          const result = await deps.ensureDeploymentRoutable({
            deploymentId: rec.deploymentId,
            kind: rec.kind,
            tenantId: rec.tenantId,
            creatorPrincipalId: deployPrincipal,
          });
          if (result.reestablished) reestablished += 1;
        } catch (err) {
          log.warn("workflow reconcile: re-establish failed for deployment", {
            deploymentId: rec.deploymentId,
            kind: rec.kind,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (reestablished > 0 || skippedNoPrincipal > 0 || dormant > 0) {
        log.info("workflow reconcile pass complete", {
          activeRecords: activeRecords.length,
          reestablished,
          skippedNoPrincipal,
          dormant,
        });
      }
    } finally {
      reconciling = false;
    }
  }

  // Recover the DEPLOY principal per `kind tenantId` from the published-definition
  // registry (`workflow_run`). A per-run record's own `principalId` is the run
  // OWNER, but `ensureDeploymentRoutable` revives the supervisor's agent/instance
  // rows as the DEPLOYER, so the registry is the source of that principal — the
  // same recovery `reconcileAll` performs.
  async function loadDeployPrincipalByKind(): Promise<Map<string, string>> {
    const registryRows = await deps.db
      .select({
        kind: workflowRun.kind,
        tenantId: workflowRun.tenantId,
        principalId: workflowRun.principalId,
      })
      .from(workflowRun)
      .where(
        and(isNotNull(workflowRun.deploymentId), isNull(workflowRun.deletedAt)),
      );
    const byKind = new Map<string, string>();
    for (const r of registryRows) {
      byKind.set(`${r.kind} ${r.tenantId}`, r.principalId);
    }
    return byKind;
  }

  async function reconcileAwaiting(): Promise<AwaitingPrewarmSummary> {
    const summary: AwaitingPrewarmSummary = {
      candidates: 0,
      reestablished: 0,
      alreadyRoutable: 0,
      skippedNoPrincipal: 0,
      failed: 0,
      hibernated: 0,
      dormant: 0,
      redelivered: 0,
    };

    // PENDING-SIGNAL PASS (runs before the awaiting sweep): a 202-accepted
    // gate signal is durable on the run record until the log proves receipt.
    // Any record still carrying one is the delivery backstop's problem, not
    // hibernation's — wake it if needed and re-deliver, never hibernate it.
    // Scans `running` too: the resume path optimistically flips the record to
    // `running` before the signal lands, and a lost signal there leaves a
    // routable no-progress supervisor the liveness sweep will never fail.
    const pendingRecords = await deps.db
      .select({
        id: workflowRunRecord.id,
        deploymentId: workflowRunRecord.deploymentId,
        kind: workflowRunRecord.kind,
        tenantId: workflowRunRecord.tenantId,
        pendingSignal: workflowRunRecord.pendingSignal,
      })
      .from(workflowRunRecord)
      .where(
        and(
          inArray(workflowRunRecord.status, ["running", "awaiting"]),
          isNotNull(workflowRunRecord.pendingSignal),
          isNotNull(workflowRunRecord.deploymentId),
          isNull(workflowRunRecord.deletedAt),
        ),
      );
    const now = Date.now();
    const routable = new Set(deps.getRoutableAddresses());
    const deployPrincipalByKind = await loadDeployPrincipalByKind();
    // Deployments owned by the pending pass; the awaiting sweep below must
    // not hibernate or dormant-skip them.
    const pendingHandled = new Set<string>();
    for (const rec of pendingRecords) {
      const pending = rec.pendingSignal;
      if (rec.deploymentId === null || pending === null) continue;
      if (pending === undefined) continue;
      pendingHandled.add(rec.deploymentId);
      const address = deriveDeploymentAddress({
        deploymentId: rec.deploymentId,
        deploymentDomain: deps.deploymentDomain,
      });
      // Give the in-flight first delivery time to land and its
      // SignalReceived to fold (which clears the record) before
      // re-delivering. Re-delivery reuses the SAME signalId, so a duplicate
      // reaching an already-satisfied gate is inert for that gate; the
      // narrow same-name-future-gate FIFO hazard is bounded by this delay.
      const pendingForMs = now - Date.parse(pending.receivedAt);
      if (pendingForMs < signalRedeliveryDelayMs) continue;
      const deployPrincipal = deployPrincipalByKind.get(
        `${rec.kind} ${rec.tenantId}`,
      );
      if (deployPrincipal === undefined) {
        summary.skippedNoPrincipal += 1;
        continue;
      }
      try {
        await deps.ensureDeploymentRoutable({
          deploymentId: rec.deploymentId,
          kind: rec.kind,
          tenantId: rec.tenantId,
          creatorPrincipalId: deployPrincipal,
        });
        deps.sendSignalDeliver({
          agentAddress: address,
          runId: rec.id,
          signalName: pending.signalName,
          signalId: pending.signalId,
          payload: pending.payload,
        });
        summary.redelivered += 1;
      } catch (err) {
        summary.failed += 1;
        log.error("pending gate signal re-delivery failed", {
          runId: rec.id,
          deploymentId: rec.deploymentId,
          signalName: pending.signalName,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }

    const awaitingRecords = await deps.db
      .select({
        id: workflowRunRecord.id,
        deploymentId: workflowRunRecord.deploymentId,
        kind: workflowRunRecord.kind,
        tenantId: workflowRunRecord.tenantId,
        updatedAt: workflowRunRecord.updatedAt,
        pendingSignal: workflowRunRecord.pendingSignal,
      })
      .from(workflowRunRecord)
      .where(
        and(
          eq(workflowRunRecord.status, "awaiting"),
          isNotNull(workflowRunRecord.deploymentId),
          isNull(workflowRunRecord.deletedAt),
        ),
      );
    if (awaitingRecords.length === 0) return summary;

    const seen = new Set<string>();
    for (const rec of awaitingRecords) {
      if (rec.deploymentId === null || seen.has(rec.deploymentId)) continue;
      seen.add(rec.deploymentId);
      // Owned by the pending-signal pass above (a signal is in flight or was
      // just re-delivered) — never hibernated, never dormant-skipped. The
      // in-JS check also covers a record whose pending signal was written
      // between the two selects.
      if (pendingHandled.has(rec.deploymentId) || rec.pendingSignal != null) {
        continue;
      }
      summary.candidates += 1;

      const address = deriveDeploymentAddress({
        deploymentId: rec.deploymentId,
        deploymentDomain: deps.deploymentDomain,
      });
      // Age of the park. A parked run's record is written only when its run
      // log advances (the last fold is SignalAwaited), so `updatedAt` is the
      // park time; each resumed-then-reparked gate refreshes it.
      const parkedForMs = now - rec.updatedAt.getTime();

      if (routable.has(address)) {
        // Parked past the grace with a live supervisor: hibernate — send the
        // state-preserving teardown so the child subprocess and supervisor
        // residency stop burning sidecar RAM for the whole human wait. The
        // undeploy ack drops the address from the routable set, and the next
        // gate signal's `ensureDeploymentRoutable` re-establishes it.
        if (parkedForMs >= hibernationGraceMs) {
          // CAS: re-read the record immediately before the teardown and only
          // hibernate if it is STILL the run we decided on — status
          // `awaiting`, no writes since the decision read, no signal
          // accepted meanwhile. This shrinks the resume-then-kill race to
          // the undeploy frame's flight time. The residual (a signal lands
          // and the run resumes mid-flight, then the teardown kills it
          // mid-step) leaves a `running` run whose supervisor is gone — the
          // run liveness sweep fails it visibly; it is not resumable.
          const fresh = await loadRunRecord(deps.db, rec.id);
          if (
            fresh === null ||
            fresh.status !== "awaiting" ||
            fresh.pendingSignal != null ||
            fresh.updatedAt === undefined ||
            fresh.updatedAt.getTime() !== rec.updatedAt.getTime()
          ) {
            continue;
          }
          try {
            await deps.sendAgentUndeploy(
              address,
              WORKFLOW_HIBERNATE_UNDEPLOY_REASON,
            );
            summary.hibernated += 1;
          } catch (err) {
            summary.failed += 1;
            log.error("hibernate teardown failed for parked deployment", {
              deploymentId: rec.deploymentId,
              kind: rec.kind,
              error: err instanceof Error ? err : new Error(String(err)),
            });
          }
          continue;
        }
        // Under the grace and routable: the healthy case (the supervisor
        // survived, or a reconnect reconcile already re-established it).
        // Skip — never re-drive a deploy frame at a live supervisor.
        summary.alreadyRoutable += 1;
        continue;
      }

      // Unroutable and parked past the grace: hibernated (or crashed after
      // the grace elapsed — indistinguishable, and identically resumable).
      // Leave it down; wake is signal-driven via the signal path's
      // `ensureDeploymentRoutable`, so the pre-warm must not fight the
      // hibernation sweep by resurrecting the child it just killed.
      if (parkedForMs >= hibernationGraceMs) {
        summary.dormant += 1;
        continue;
      }

      const deployPrincipal = deployPrincipalByKind.get(
        `${rec.kind} ${rec.tenantId}`,
      );
      if (deployPrincipal === undefined) {
        // The kind was undeployed since the run parked — no registry row to
        // recover the deploy principal, so the supervisor cannot be revived.
        summary.skippedNoPrincipal += 1;
        continue;
      }

      try {
        const result = await deps.ensureDeploymentRoutable({
          deploymentId: rec.deploymentId,
          kind: rec.kind,
          tenantId: rec.tenantId,
          creatorPrincipalId: deployPrincipal,
        });
        if (result.reestablished) summary.reestablished += 1;
      } catch (err) {
        // Surface (do not swallow) and keep sweeping the rest of the batch — one
        // parked run's establish failure must not strand the others.
        summary.failed += 1;
        log.error("awaiting pre-warm: re-establish failed for deployment", {
          deploymentId: rec.deploymentId,
          kind: rec.kind,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }

    if (
      summary.reestablished > 0 ||
      summary.failed > 0 ||
      summary.hibernated > 0 ||
      summary.redelivered > 0
    ) {
      log.info("awaiting pre-warm pass complete", {
        candidates: summary.candidates,
        reestablished: summary.reestablished,
        alreadyRoutable: summary.alreadyRoutable,
        skippedNoPrincipal: summary.skippedNoPrincipal,
        failed: summary.failed,
        hibernated: summary.hibernated,
        dormant: summary.dormant,
        redelivered: summary.redelivered,
      });
    }
    return summary;
  }

  async function reclaimOrphanedDeployments(): Promise<void> {
    const cutoff = new Date(Date.now() - ORPHAN_RECLAIM_WINDOW_MS);
    const recentTerminal = await deps.db
      .select({
        deploymentId: workflowRunRecord.deploymentId,
        tenantId: workflowRunRecord.tenantId,
      })
      .from(workflowRunRecord)
      .where(
        and(
          inArray(workflowRunRecord.status, ["completed", "failed"]),
          isNotNull(workflowRunRecord.deploymentId),
          // Soft-deleted (archived) terminal runs are INCLUDED: an archive whose
          // immediate teardown failed still has a live deployment that must be
          // reclaimed (CL-2629). The per-deploymentId liveness LIKE below gates
          // exactly what gets torn down, so seeing archived rows is safe.
          gt(workflowRunRecord.updatedAt, cutoff),
        ),
      );

    const seen = new Set<string>();
    let reclaimed = 0;
    for (const rec of recentTerminal) {
      if (rec.deploymentId === null || seen.has(rec.deploymentId)) continue;
      seen.add(rec.deploymentId);
      // Scoped, per-deploymentId liveness check — a LIKE on this exact
      // deploymentId's instance prefix, never a broad `ins_ses_%` sweep, so it
      // can only ever match THIS workflow deployment's supervisor/step rows
      // (no risk of touching a non-workflow agent's instances). A terminal run
      // whose teardown already fired has no live rows → skipped.
      const live = await deps.db
        .select({ id: intxSchema.agentInstance.id })
        .from(intxSchema.agentInstance)
        .where(
          and(
            like(intxSchema.agentInstance.address, `ins_${rec.deploymentId}%`),
            isNull(intxSchema.agentInstance.endedAt),
          ),
        )
        .limit(1);
      if (live.length === 0) continue;
      try {
        await deps.reclaimDeployment({
          deploymentId: rec.deploymentId,
          tenantId: rec.tenantId,
          reason: "terminal run deployment reclaimed by janitor (CL-2582)",
        });
        reclaimed += 1;
      } catch (err) {
        log.warn("orphan reclaim failed for deployment", {
          deploymentId: rec.deploymentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (reclaimed > 0) {
      log.info("reclaimed orphaned terminal deployments", { reclaimed });
    }
  }

  return {
    failOrphanedRuns,
    reconcileAll,
    reconcileAwaiting,
    reclaimOrphanedDeployments,
    start() {
      // The handler is awaited by the sidecar-handler's reconnect flow; it must
      // never throw, or it would fail the address's reconnection. reconcileAll is
      // self-guarded; fire-and-forget with an internal catch keeps this safe.
      return deps.events.on("agent.reconnected", () => {
        void reconcileAll().catch((err) => {
          log.warn("workflow reconcile pass failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      });
    },
  };
}

// Single contract-guaranteed default cadence for the awaiting pre-warm backstop
// (CL-2756). 30s mirrors the chat-side wedge sweep: frequent enough that a
// gate-parked supervisor is re-established well before a human returns to the
// gate, cheap because each tick is a no-op for already-routable supervisors.
export const DEFAULT_AWAITING_PREWARM_INTERVAL_MS = 30_000;

// Register the periodic awaiting-supervisor pre-warm on an interval. Owns a
// reentrancy flag (a slow tick must not overlap the next) and returns an
// unsubscribe that clears the timer (mirrors `registerWedgeSweepReconciler`'s
// teardown contract). The timer is `unref`'d so it never keeps the process alive.
export function registerAwaitingSupervisorPrewarm(deps: {
  reconciler: Pick<WorkflowReconciler, "reconcileAwaiting">;
  intervalMs?: number;
}): () => void {
  const intervalMs = deps.intervalMs ?? DEFAULT_AWAITING_PREWARM_INTERVAL_MS;
  let sweeping = false;

  const timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void deps.reconciler
      .reconcileAwaiting()
      .catch((err) => {
        log.error("awaiting pre-warm tick failed", {
          error: err instanceof Error ? err : new Error(String(err)),
        });
      })
      .finally(() => {
        sweeping = false;
      });
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  return () => clearInterval(timer);
}
