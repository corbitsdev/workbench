import { and, eq, inArray, ne } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import type { DB } from "@intx/db";
import type { SessionService, SidecarRouter } from "@intx/hub-sessions";
import { isWorkflowDerivedAddress } from "@intx/workflow-deploy";
import { getLogger } from "@intx/log";
import { isReapableAgentInstance } from "@workbench/agents";
import type { EventCollectorRegistry } from "@workbench/event-collector";

const log = getLogger(["services", "idle-session-reaper"]);

const { agent, agentInstance, agentSession } = intxSchema;

// CL-2790: idle agent-session sleep / reaper, now universal over
// agent kind: EVERY chat/sub-agent instance is reapable now, not just the
// personal agent (Myra).
//
// A user-facing chat agent (Myra, Oat, …) is launched on a shared sidecar and
// stays resident for the life of its session. A workbench with many users
// accretes live sessions that never sleep, each holding sidecar RAM and a warm
// harness, long after the human stopped talking. This sweep sleeps a chat
// session that has seen no activity for `reapAfterMs` by undeploying it and
// marking its `agent_session` ended, leaving the `agent_instance` relaunchable
// so the next interaction brings the agent back cold. The WAKE is launch-on-
// demand, never automatic: every Myra chat surface (`useMyraSession` — the
// full-page thread and the bottom-right popup) unconditionally calls
// `POST /v1/instances/:id/sessions` before opening its stream, and the
// send-mail route relaunches a non-routable instance ahead of dispatch — both
// paths cold-relaunch a slept instance (undeployed → not routable → falls
// through to `launchAgentSession` / `relaunchInstanceIfNeeded`). No agent is
// ever woken except by an inbound mail/message.
//
// SAFETY — this EVICTS LIVE sessions, so over-eviction is the hazard. Every gate
// below is a positive check that the address is a genuinely-idle agent
// instance; anything unrecognized is left alone:
//
//   1. Candidates are `agent_instance` rows with an `active` session and a
//      relaunchable instance status. Workflow supervisors and per-step children
//      carry NO `agent_instance` row (they are deployments), so they are
//      structurally excluded — never a candidate. `isWorkflowDerivedAddress` is
//      a belt-and-suspenders second gate.
//   2. The address must be ROUTABLE now — we only sleep something that is
//      actually live. A non-routable candidate is a wedge for the wedge sweep to
//      relaunch, not ours to touch.
//   3. The agent must be a reapable, recognized template
//      (`isReapableAgentInstance`) — an explicit allowlist excludes ephemeral,
//      single-purpose invocations (inbox triage, the internal file-parser
//      call) that end when their one job is done rather than sleeping; an
//      unrecognized agent name is never slept.
//   4. Activity recency subsumes "no pending inbound work": a chat agent that
//      just received mail is mid-turn and streaming `agent.event`s, so its
//      `lastActive` is fresh and it is spared. A live/connected address has no
//      hub-side pending-mail queue (mail is delivered synchronously), so recency
//      is the correct in-flight guard.
//   5. First sighting SEEDS the tracker instead of evicting. After a hub restart
//      the tracker is empty; without this every idle-looking agent would be
//      slept at once. Seeding gives each live agent a fresh full grace window.
//   6. Marking the session ended is gated on `status != 'ended'` and leaves the
//      instance status untouched (relaunchable). Once ended, the wedge sweep
//      (which requires an `active` session) ignores the address — the two sweeps
//      never fight.
//   7. IN-FLIGHT TURN (CL-2795): recency alone can go stale during a long
//      blocking tool call — the `tool.start`→`tool.done` window emits no
//      persisted `agent.event`s, so `lastActive` can age past the threshold while
//      the agent is genuinely mid-turn. Before sleeping a candidate we consult the
//      live event-collector: an open turn (`getCurrentTurnId != null`) or a
//      `busy`/`waiting_approval` status means the agent is working, so it is
//      spared (counted `skippedBusy`). `currentTurnId` is set on `inference.start`
//      and cleared only on turn finalization, so it stays non-null across the
//      whole tool loop — exactly the window recency cannot see. Recency and this
//      guard are COMPLEMENTARY, not redundant: recency covers every other window
//      (streaming inference, between turns, and the launch→first-`inference.start`
//      gap where the collector has no turn yet); the turn guard covers only the
//      silent intra-turn tool window. Neither alone spares every working agent —
//      keep both if either signal path is ever changed.
//
// CL-2795 flipped this reaper always-on (the former `IDLE_SESSION_REAP_ENABLED`
// kill switch is gone); it actively evicts on staging, defaulting to a 5-minute
// idle threshold swept every minute.
export interface IdleSessionReaper {
  // Record activity for an agent address (an agent event, or an inbound user
  // message). Bumps the address's last-active clock so the next sweep spares it.
  recordActivity(agentAddress: string): void;
  // Record activity for an instance by id (the send-mail route has the
  // instanceId, not the address). Best-effort: resolves the address then
  // records; a lookup failure is logged, never thrown. Returns the settle
  // promise (never rejects) so callers can fire-and-forget (`void …`) while
  // tests can await it deterministically.
  recordActivityForInstance(instanceId: string): Promise<void>;
  // Run one pass. Returns scan/evict counts (for logging + tests).
  sweepOnce(): Promise<{ scanned: number; evicted: number }>;
  // Start the interval loop; returns a handle that clears it.
  start(): () => void;
}

const RELAUNCHABLE_STATUSES = ["running", "deployed", "updating"] as const;

const DEFAULT_REAP_AFTER_MS = 5 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 60 * 1000;

export function createIdleSessionReaper(deps: {
  db: DB["db"];
  endSession: SessionService["endSession"];
  getRoutableAddresses: SidecarRouter["getRoutableAddresses"];
  // Live in-flight-turn signal (CL-2795): consulted before every eviction so an
  // agent mid-turn (open turn, or busy/waiting_approval status) is never slept,
  // even when a long blocking tool call has aged its recency clock.
  eventCollectors: Pick<
    EventCollectorRegistry,
    "getCurrentTurnId" | "getStatus"
  >;
  reapAfterMs?: number;
  intervalMs?: number;
  now?: () => number;
}): IdleSessionReaper {
  const reapAfterMs = deps.reapAfterMs ?? DEFAULT_REAP_AFTER_MS;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = deps.now ?? (() => Date.now());
  // agentAddress → last-active epoch ms. Only chat addresses are tracked;
  // workflow-derived addresses are ignored so the map cannot grow with the
  // churn of ephemeral per-step children.
  const lastActive = new Map<string, number>();
  let sweeping = false;

  function recordActivity(agentAddress: string): void {
    if (isWorkflowDerivedAddress(agentAddress)) return;
    lastActive.set(agentAddress, now());
  }

  function recordActivityForInstance(instanceId: string): Promise<void> {
    return deps.db
      .select({ address: agentInstance.address })
      .from(agentInstance)
      .where(eq(agentInstance.id, instanceId))
      .limit(1)
      .then((rows) => {
        const address = rows[0]?.address;
        if (address !== undefined) recordActivity(address);
      })
      .catch((err) => {
        log.warn("idle reaper: failed to resolve instance for activity", {
          instanceId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  async function markSessionEnded(sessionId: string, at: Date): Promise<void> {
    await deps.db
      .update(agentSession)
      .set({ status: "ended", endedAt: at, updatedAt: at })
      .where(
        and(eq(agentSession.id, sessionId), ne(agentSession.status, "ended")),
      );
  }

  async function sweepOnce(): Promise<{ scanned: number; evicted: number }> {
    if (sweeping) return { scanned: 0, evicted: 0 };
    sweeping = true;
    try {
      const routable = new Set(deps.getRoutableAddresses());

      const candidates = await deps.db
        .select({
          address: agentInstance.address,
          sessionId: agentInstance.sessionId,
          tenantId: agentInstance.tenantId,
          agentName: agent.name,
        })
        .from(agentInstance)
        .innerJoin(agentSession, eq(agentInstance.sessionId, agentSession.id))
        .innerJoin(agent, eq(agentInstance.agentId, agent.id))
        .where(
          and(
            eq(agentSession.status, "active"),
            inArray(agentInstance.status, [...RELAUNCHABLE_STATUSES]),
          ),
        );

      const nowMs = now();
      let evicted = 0;
      let seeded = 0;
      let skippedEphemeral = 0;
      let skippedUnroutable = 0;
      let skippedRecent = 0;
      let skippedBusy = 0;
      let failedEvictions = 0;

      for (const cand of candidates) {
        if (!routable.has(cand.address)) {
          skippedUnroutable += 1;
          continue;
        }
        if (isWorkflowDerivedAddress(cand.address)) continue;
        if (!isReapableAgentInstance(cand.agentName)) {
          skippedEphemeral += 1;
          continue;
        }
        if (cand.sessionId === null) continue;

        const last = lastActive.get(cand.address);
        if (last === undefined) {
          lastActive.set(cand.address, nowMs);
          seeded += 1;
          continue;
        }
        const idleMs = nowMs - last;
        if (idleMs < reapAfterMs) {
          skippedRecent += 1;
          continue;
        }

        // In-flight-turn guard (CL-2795): an open turn or a busy/
        // waiting-approval status means the agent is mid-work — spare it even
        // though its recency clock aged out during a silent blocking tool call.
        const turnId = deps.eventCollectors.getCurrentTurnId(cand.address);
        const status = deps.eventCollectors.getStatus(cand.address)?.status;
        if (
          turnId != null ||
          status === "busy" ||
          status === "waiting_approval"
        ) {
          skippedBusy += 1;
          continue;
        }

        try {
          await deps.endSession(cand.address, "idle");
          await markSessionEnded(cand.sessionId, new Date(nowMs));
          lastActive.delete(cand.address);
          evicted += 1;
          log.info("idle reaper: slept idle agent session", {
            address: cand.address,
            tenantId: cand.tenantId,
            agentName: cand.agentName,
            idleMs,
          });
        } catch (err) {
          // Leave the tracker entry so the next sweep retries; the session stays
          // active (not marked ended) so nothing is left half-torn-down.
          failedEvictions += 1;
          log.warn("idle reaper: eviction failed", {
            address: cand.address,
            tenantId: cand.tenantId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Bound the tracker: drop entries for addresses that are no longer live.
      for (const address of [...lastActive.keys()]) {
        if (!routable.has(address)) lastActive.delete(address);
      }

      log.info("idle reaper pass summary", {
        scanned: candidates.length,
        evicted,
        seeded,
        skippedEphemeral,
        skippedUnroutable,
        skippedRecent,
        skippedBusy,
        failedEvictions,
        tracked: lastActive.size,
      });
      return { scanned: candidates.length, evicted };
    } finally {
      sweeping = false;
    }
  }

  return {
    recordActivity,
    recordActivityForInstance,
    sweepOnce,
    start() {
      const handle = setInterval(() => {
        void sweepOnce().catch((err) => {
          log.warn("idle reaper pass failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, intervalMs);
      if (typeof handle.unref === "function") handle.unref();
      return () => clearInterval(handle);
    },
  };
}
