import { and, eq, inArray, ne } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import type { DB } from "@intx/db";
import type { SessionService, SidecarRouter } from "@intx/hub-sessions";
import { isWorkflowDerivedAddress } from "@intx/workflow-deploy";
import { getLogger } from "@intx/log";
import { isReapableChatAgent } from "@workbench/agents";

const log = getLogger(["services", "idle-session-reaper"]);

const { agent, agentInstance, agentSession } = intxSchema;

// CL-2790: idle chat-session sleep / reaper.
//
// A user-facing chat agent (Myra, Oat, …) is launched on a shared sidecar and
// stays resident for the life of its session. A workbench with many users
// accretes live sessions that never sleep, each holding sidecar RAM and a warm
// harness, long after the human stopped talking. This sweep sleeps a chat
// session that has seen no activity for `reapAfterMs` by undeploying it and
// marking its `agent_session` ended, leaving the `agent_instance` relaunchable
// so the next interaction (POST /v1/me) brings the agent back cold.
//
// SAFETY — this EVICTS LIVE sessions, so over-eviction is the hazard. Every gate
// below is a positive check that the address is a genuinely-idle user chat
// agent; anything unrecognized is left alone:
//
//   1. Candidates are `agent_instance` rows with an `active` session and a
//      relaunchable instance status. Workflow supervisors and per-step children
//      carry NO `agent_instance` row (they are deployments), so they are
//      structurally excluded — never a candidate. `isWorkflowDerivedAddress` is
//      a belt-and-suspenders second gate.
//   2. The address must be ROUTABLE now — we only sleep something that is
//      actually live. A non-routable candidate is a wedge for the wedge sweep to
//      relaunch, not ours to touch.
//   3. The agent must be a reapable CHAT template (`isReapableChatAgent`). The
//      non-chat system agents (Loop, file-parser) are `deployable: false` and
//      must stay up; an unrecognized agent name is never slept.
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

const DEFAULT_REAP_AFTER_MS = 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export function createIdleSessionReaper(deps: {
  db: DB["db"];
  endSession: SessionService["endSession"];
  getRoutableAddresses: SidecarRouter["getRoutableAddresses"];
  enabled: boolean;
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
    if (!deps.enabled) return { scanned: 0, evicted: 0 };
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
      let skippedNonChat = 0;
      let skippedUnroutable = 0;
      let skippedRecent = 0;
      let failedEvictions = 0;

      for (const cand of candidates) {
        if (!routable.has(cand.address)) {
          skippedUnroutable += 1;
          continue;
        }
        if (isWorkflowDerivedAddress(cand.address)) continue;
        if (!isReapableChatAgent(cand.agentName)) {
          skippedNonChat += 1;
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

        try {
          await deps.endSession(cand.address, "idle");
          await markSessionEnded(cand.sessionId, new Date(nowMs));
          lastActive.delete(cand.address);
          evicted += 1;
          log.info("idle reaper: slept idle chat session", {
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
        skippedNonChat,
        skippedUnroutable,
        skippedRecent,
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
