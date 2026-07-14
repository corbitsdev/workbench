import { and, eq, gte, inArray } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import type { DB } from "@intx/db";
import { getLogger } from "@intx/log";
import type {
  EventCollectorRegistry,
  SessionService,
  SidecarRouter,
} from "@intx/hub-sessions";
import type { GrantStore } from "@intx/types/authz";
import { AGENT_TEMPLATES } from "@workbench/agents";
import { memberAgentInstance } from "../db/schema";
import { relaunchInstanceIfNeeded } from "./agent-provisioning";

const log = getLogger(["api", "prewarm"]);

const { agentInstance } = intxSchema;

// A member returning to the app after this long is unlikely to open Myra before
// the next sidecar restart re-sleeps her, so 24h keeps the prewarm set small
// (only genuinely-active members) while covering everyone likely to chat today.
export const DEFAULT_PREWARM_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
// Launches are serialized through the coalescer/dedup breaker per instance, but
// distinct instances launch in parallel; a low default keeps the just-
// reconnected sidecar from being stampeded while it also serves live traffic.
export const DEFAULT_PREWARM_CONCURRENCY = 2;
export const MAX_PREWARM_CONCURRENCY = 8;
// Same cadence as the wedge sweep: frequent enough that a member's personal
// agent is warm within seconds of a reconnect, cheap because a tick with no
// cold personal instances is a single indexed select plus a routable-set diff.
export const DEFAULT_PREWARM_SWEEP_INTERVAL_MS = 30_000;

// The set of template keys whose instances are per-member personal agents
// (Myra). The "personal" kind is the domain policy owned by @workbench/agents;
// the hub only consumes it (mirrors the /agents route's exclusion filter).
export function personalTemplateKeys(): string[] {
  return AGENT_TEMPLATES.filter((t) => t.kind === "personal").map((t) => t.key);
}

function clampConcurrency(value: number): number {
  if (value < 1) return 1;
  if (value > MAX_PREWARM_CONCURRENCY) return MAX_PREWARM_CONCURRENCY;
  return value;
}

async function drainWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runWorker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) continue;
      await worker(item);
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
 * `activeWindowMs`, drops any whose address is already routable, and launches
 * the rest through `relaunchInstanceIfNeeded` under bounded concurrency.
 *
 * Every launch is funneled through the same per-instance coalescer/dedup breaker
 * the sessions route uses, so a user-initiated launch and a prewarm of the same
 * instance can never double-launch; `relaunchInstanceIfNeeded` also re-reads
 * routability and the session status right before launching, so an instance that
 * became live between the select and its turn in the queue is a no-op. A single
 * instance's launch failure is logged and swallowed so it neither aborts the
 * remaining candidates nor rejects the sweep — the next tick retries it.
 */
export async function prewarmPersonalAgents(
  db: DB["db"],
  sidecarRouter: SidecarRouter,
  sessionService: SessionService,
  grantStore: GrantStore,
  eventCollectors: EventCollectorRegistry,
  opts: {
    templateKeys: string[];
    activeWindowMs?: number;
    concurrency?: number;
    now?: number;
  },
): Promise<void> {
  const { templateKeys } = opts;
  if (templateKeys.length === 0) return;

  const activeWindowMs =
    opts.activeWindowMs ?? DEFAULT_PREWARM_ACTIVE_WINDOW_MS;
  const concurrency = clampConcurrency(
    opts.concurrency ?? DEFAULT_PREWARM_CONCURRENCY,
  );
  const now = opts.now ?? Date.now();
  const cutoff = new Date(now - activeWindowMs);

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

  let prewarmed = 0;
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
      prewarmed += 1;
    } catch (err) {
      log.warn("Failed to prewarm personal agent instance", {
        instanceId,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  });

  if (prewarmed > 0) {
    log.info("Prewarmed personal agents after sidecar reconnect", {
      prewarmed,
    });
  }
}

/**
 * Registers the periodic personal-agent prewarm on an interval. Owns a
 * reentrancy flag (a slow tick with many cold instances must not overlap the
 * next) and returns an unsubscribe that clears the timer (mirrors the wedge
 * sweep's teardown contract). The timer is `unref`'d so it never keeps the
 * process alive on its own.
 */
export function registerPersonalAgentPrewarm(deps: {
  db: DB["db"];
  router: SidecarRouter;
  sessionService: SessionService;
  grantStore: GrantStore;
  eventCollectors: EventCollectorRegistry;
  activeWindowMs?: number;
  concurrency?: number;
  intervalMs?: number;
}): () => void {
  const intervalMs = deps.intervalMs ?? DEFAULT_PREWARM_SWEEP_INTERVAL_MS;
  const templateKeys = personalTemplateKeys();
  let sweeping = false;

  const timer = setInterval(() => {
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
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  return () => clearInterval(timer);
}
