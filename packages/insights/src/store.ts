import type { TokenClasses, TokenRates } from "./pricing";

export type UsageTurnRecord = {
  readonly id: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly provider: string | null;
  readonly model: string;
  readonly tokens: TokenClasses;
  readonly reportedCostUsd: number | null;
  readonly recordedAt: Date;
};

export type ModelPriceRecord = {
  readonly model: string;
  readonly rates: TokenRates;
};

export type InsertUsageInput = {
  readonly id: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly provider?: string;
  readonly model: string;
  readonly tokens: TokenClasses;
  readonly reportedCostUsd?: number;
  readonly recordedAt?: Date;
};

export type UsageStore = {
  /** Insert a turn. Returns the row, or null if turnId already exists (idempotent). */
  insertUsage(input: InsertUsageInput): Promise<UsageTurnRecord | null>;
  /**
   * Rows for every tenant in `tenantIds` — the DB-layer aggregation seam a
   * multi-tenant scope (a workspace parent plus its child workbenches)
   * sums over, so a query never has to fan out into one browser fetch per
   * tenant. A single-element array is the plain single-tenant read.
   */
  listUsageByTenants(
    tenantIds: readonly string[],
    opts?: { from?: Date; to?: Date },
  ): Promise<readonly UsageTurnRecord[]>;
  getPrice(model: string): Promise<ModelPriceRecord | null>;
  listPrices(): Promise<readonly ModelPriceRecord[]>;
  upsertPrice(price: ModelPriceRecord): Promise<ModelPriceRecord>;
};

/**
 * In-memory store for unit tests and local smoke. Production wiring
 * uses a drizzle-backed implementation against the same interface.
 */
export function createMemoryUsageStore(
  seedPrices: readonly ModelPriceRecord[] = [],
): UsageStore {
  const turns = new Map<string, UsageTurnRecord>();
  const byTurnId = new Map<string, string>();
  const prices = new Map<string, ModelPriceRecord>(
    seedPrices.map((p) => [p.model, p]),
  );

  return {
    async insertUsage(input) {
      if (byTurnId.has(input.turnId)) return null;
      const record: UsageTurnRecord = {
        id: input.id,
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        provider: input.provider ?? null,
        model: input.model,
        tokens: input.tokens,
        reportedCostUsd: input.reportedCostUsd ?? null,
        recordedAt: input.recordedAt ?? new Date(),
      };
      turns.set(record.id, record);
      byTurnId.set(record.turnId, record.id);
      return record;
    },
    async listUsageByTenants(tenantIds, opts) {
      const scope = new Set(tenantIds);
      return [...turns.values()]
        .filter((t) => scope.has(t.tenantId))
        .filter((t) =>
          opts?.from === undefined ? true : t.recordedAt >= opts.from,
        )
        .filter((t) =>
          opts?.to === undefined ? true : t.recordedAt <= opts.to,
        )
        .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
    },
    async getPrice(model) {
      return prices.get(model) ?? null;
    },
    async listPrices() {
      return [...prices.values()];
    },
    async upsertPrice(price) {
      prices.set(price.model, price);
      return price;
    },
  };
}
