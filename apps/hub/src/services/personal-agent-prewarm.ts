import { and, eq, gte, inArray } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import type { DB } from "@intx/db";
import { getLogger } from "@intx/log";
import { SessionLaunchError } from "@intx/hub-sessions";
import type {
  EventCollectorRegistry,
  SessionService,
  SidecarRouter,
} from "@intx/hub-sessions";
import type { GrantStore } from "@intx/types/authz";
import { AGENT_TEMPLATES } from "@workbench/agents";
import { memberAgentInstance } from "../db/schema";
import {
  relaunchInstanceIfNeeded,
  WEDGE_RELAUNCHABLE_STATUSES,
} from "./agent-provisioning";

const log = getLogger(["api", "prewarm"]);

const { agentInstance } = intxSchema;

// The set of template keys whose instances are per-member personal agents
// (Myra). The "personal" kind is the domain policy owned by @workbench/agents;
// the hub only consumes it (mirrors the /agents route's exclusion filter).
export function personalTemplateKeys(): string[] {
  return AGENT_TEMPLATES.filter((t) => t.kind === "personal").map((t) => t.key);
}

// A provision-phase launch failure whose cause is the router having no sidecar
// to deploy onto ("No sidecar available/connected for agent ..." thrown by
// @intx/hub-sessions' sidecar-handler sendAgentDeploy). During the post-boot
// reconnect window every candidate would fail the same way — and each attempt
// arms that instance's dedup-breaker cooldown, delaying its REAL prewarm — so
// a tick aborts on the first such failure instead of iterating the whole
// candidate set into it. Message-based by necessity: the router throws a bare
// Error that the launch wraps in a provision-phase SessionLaunchError.
export function isSidecarUnavailableLaunchError(err: unknown): boolean {
  return (
    err instanceof SessionLaunchError &&
    err.phase === "provision" &&
    err.message.includes("No sidecar")
  );
}

async function drainWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<"continue" | "abort">,
): Promise<void> {
  let cursor = 0;
  let aborted = false;
  const runWorker = async (): Promise<void> => {
    while (!aborted && cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) continue;
      const verdict = await worker(item);
      if (verdict === "abort") aborted = true;
    }
  };
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runWorker(),
  );
  await Promise.all(workers);
}

/**
 * One prewarm pass. Selects personal-agent instances of members active within
 * `activeWindowMs` — measured on `member_agent_instance.lastActivityAt`, which
 * the hub mail middleware bumps on every inbound user message (see
 * recordMyraThreadActivity in myra-threads.ts) — whose instance is in a
 * relaunchable status, drops any whose address is already routable, and
 * launches the rest through `relaunchInstanceIfNeeded` under bounded
 * concurrency.
 *
 * Every launch is funneled through the same per-instance coalescer/dedup breaker
 * the sessions route uses, so a user-initiated launch and a prewarm of the same
 * instance can never double-launch; `relaunchInstanceIfNeeded` also re-reads
 * routability and the session status right before launching, so an instance that
 * became live between the select and its turn in the queue is a no-op. A single
 * instance's launch failure is logged and swallowed so it neither aborts the
 * remaining candidates nor rejects the sweep — the next tick retries it. The one
 * exception is a sidecar-unavailable provision failure, which aborts the rest of
 * the tick (see isSidecarUnavailableLaunchError): the un-attempted candidates
 * are never launched into the same failure, so their cooldowns stay unarmed and
 * the next tick prewarms them cleanly.
 */
export async function prewarmPersonalAgents(
  db: DB["db"],
  sidecarRouter: SidecarRouter,
  sessionService: SessionService,
  grantStore: GrantStore,
  eventCollectors: EventCollectorRegistry,
  opts: {
    templateKeys: string[];
    activeWindowMs: number;
    concurrency: number;
    now?: number;
  },
): Promise<void> {
  const { templateKeys, activeWindowMs, concurrency } = opts;
  if (templateKeys.length === 0) return;

  const now = opts.now ?? Date.now();
  const cutoff = new Date(now - activeWindowMs);

  // member_agent_instance carries no index, but it is small (one row per
  // member thread), so an all-warm tick costs one cheap select plus a
  // routable-set diff.
  const rows = await db
    .select({
      instanceId: agentInstance.id,
      address: agentInstance.address,
    })
    .from(memberAgentInstance)
    .innerJoin(
      agentInstance,
      eq(memberAgentInstance.instanceId, agentInstance.id),
    )
    .where(
      and(
        inArray(memberAgentInstance.templateKey, templateKeys),
        gte(memberAgentInstance.lastActivityAt, cutoff),
        // Mirrors the wedge sweep's relaunchable-status constraint: a stopped
        // or errored instance must not be re-selected every tick forever.
        inArray(agentInstance.status, [...WEDGE_RELAUNCHABLE_STATUSES]),
      ),
    );

  const routable = new Set(sidecarRouter.getRoutableAddresses());
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const row of rows) {
    if (routable.has(row.address)) continue;
    if (seen.has(row.instanceId)) continue;
    seen.add(row.instanceId);
    candidates.push(row.instanceId);
  }
  if (candidates.length === 0) return;

  // Counts attempts, not proven launches: relaunchInstanceIfNeeded returns
  // void and no-ops internally (already-routable re-check, active session,
  // breaker cooldown), so the hub cannot distinguish a real launch here.
  let attempted = 0;
  await drainWithConcurrency(candidates, concurrency, async (instanceId) => {
    try {
      await relaunchInstanceIfNeeded(
        db,
        sessionService,
        grantStore,
        eventCollectors,
        instanceId,
        sidecarRouter,
      );
      attempted += 1;
      return "continue";
    } catch (err) {
      if (isSidecarUnavailableLaunchError(err)) {
        log.info("Sidecar unavailable; aborting prewarm tick", { instanceId });
        return "abort";
      }
      log.warn("Failed to prewarm personal agent instance", {
        instanceId,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return "continue";
    }
  });

  if (attempted > 0) {
    log.info("Prewarm pass attempted personal-agent launches", { attempted });
  }
}

/**
 * Builds one reentrancy-guarded prewarm tick over fixed deps: a slow sweep
 * with many cold instances must not overlap the next tick. Exported apart from
 * the interval owner so tests can drive ticks deterministically.
 */
export function createPersonalAgentPrewarmTick(deps: {
  db: DB["db"];
  router: SidecarRouter;
  sessionService: SessionService;
  grantStore: GrantStore;
  eventCollectors: EventCollectorRegistry;
  activeWindowMs: number;
  concurrency: number;
}): () => void {
  const templateKeys = personalTemplateKeys();
  let sweeping = false;

  return () => {
    if (sweeping) return;
    sweeping = true;
    void prewarmPersonalAgents(
      deps.db,
      deps.router,
      deps.sessionService,
      deps.grantStore,
      deps.eventCollectors,
      {
        templateKeys,
        activeWindowMs: deps.activeWindowMs,
        concurrency: deps.concurrency,
      },
    )
      .catch((err) => {
        log.warn("Personal-agent prewarm tick failed", {
          error: err instanceof Error ? err : new Error(String(err)),
        });
      })
      .finally(() => {
        sweeping = false;
      });
  };
}

/**
 * Registers the periodic personal-agent prewarm. The first tick waits out
 * `initialDelayMs` so the post-boot sidecar reconnect fan-out settles before
 * any launch is attempted (the wedge sweep's sustained-unroutability grace is
 * the precedent for that horizon); subsequent ticks run every `intervalMs`.
 * Returns an unsubscribe that clears both timers (mirrors the wedge sweep's
 * teardown contract). Both timers are `unref`'d so they never keep the process
 * alive on their own.
 *
 * All knobs are required: config.ts is the sole owner of their defaults and
 * their validation (including the concurrency ceiling).
 */
export function registerPersonalAgentPrewarm(deps: {
  db: DB["db"];
  router: SidecarRouter;
  sessionService: SessionService;
  grantStore: GrantStore;
  eventCollectors: EventCollectorRegistry;
  activeWindowMs: number;
  concurrency: number;
  intervalMs: number;
  initialDelayMs: number;
}): () => void {
  const tick = createPersonalAgentPrewarmTick(deps);

  let interval: ReturnType<typeof setInterval> | undefined;
  const startTimer = setTimeout(() => {
    tick();
    interval = setInterval(tick, deps.intervalMs);
    if (typeof interval.unref === "function") interval.unref();
  }, deps.initialDelayMs);
  if (typeof startTimer.unref === "function") startTimer.unref();

  return () => {
    clearTimeout(startTimer);
    if (interval !== undefined) clearInterval(interval);
  };
}
