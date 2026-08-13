import type { TokenClasses } from "./pricing";
import type { UsageStore } from "./store";

/**
 * A usage event as emitted by the live inference stream. The platform
 * event-collector drops these; this sink is the product-side consumer.
 * The shape is deliberately narrow so it can be upstreamed to Interchange
 * later without dragging workbench product fields along.
 */
export type UsageEvent = {
  readonly turnId: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly model: string;
  readonly tokens: TokenClasses;
  readonly recordedAt?: Date;
};

export type UsageSinkDeps = {
  store: UsageStore;
  /** Id generator — inject `generateId` from @intx/hub-common at the mount. */
  generateId: () => string;
};

/**
 * Persist usage events idempotently by turnId. Restart-safe: replaying
 * an already-recorded turn is a no-op, never a double count.
 */
export function createUsageSink(deps: UsageSinkDeps) {
  return {
    async handle(event: UsageEvent): Promise<"inserted" | "duplicate"> {
      const result = await deps.store.insertUsage({
        id: deps.generateId(),
        tenantId: event.tenantId,
        sessionId: event.sessionId,
        turnId: event.turnId,
        model: event.model,
        tokens: event.tokens,
        ...(event.recordedAt === undefined
          ? {}
          : { recordedAt: event.recordedAt }),
      });
      return result === null ? "duplicate" : "inserted";
    },
  };
}

export type UsageSink = ReturnType<typeof createUsageSink>;
