// Plain catalog-row literals so the resolution suites exercise the real
// algorithm with no database anywhere near them.
import type { ModelPricingRow, ResolvedOffering } from "@intx/db";
import type { Capability } from "@intx/types";

const EPOCH = new Date("2026-01-01T00:00:00.000Z");

export type OfferingFixture = {
  id: string;
  canonicalName: string;
  displayName?: string | null;
  providerName: string;
  plugin?: "anthropic" | "openai" | "openai-compatible" | "google-genai";
  capabilities: Capability[];
  priority?: number;
  connected?: boolean;
  inherited?: boolean;
};

export function offering(fixture: OfferingFixture): ResolvedOffering {
  const tenantId = "bench-1";
  return {
    offering: {
      id: fixture.id,
      tenantId,
      modelId: `model-${fixture.canonicalName}`,
      providerId: `provider-${fixture.providerName}`,
      priority: fixture.priority ?? 0,
      deploymentTags: [],
      capabilities: fixture.capabilities,
      quirks: null,
      disabled: false,
      createdAt: EPOCH,
      updatedAt: EPOCH,
    },
    model: {
      id: `model-${fixture.canonicalName}`,
      tenantId,
      canonicalName: fixture.canonicalName,
      displayName: fixture.displayName ?? fixture.canonicalName,
      description: null,
      disabled: false,
      createdAt: EPOCH,
      updatedAt: EPOCH,
    },
    provider: {
      id: `provider-${fixture.providerName}`,
      tenantId,
      name: fixture.providerName,
      plugin: fixture.plugin ?? "openai-compatible",
      baseURL: `https://${fixture.providerName}.example/v1`,
      credentialId: (fixture.connected ?? true) ? "credential-1" : null,
      walletId: null,
      disabled: false,
      createdAt: EPOCH,
      updatedAt: EPOCH,
    },
    origin: {
      tenantId: fixture.inherited === true ? "parent-bench" : tenantId,
      direct: fixture.inherited !== true,
    },
  };
}

export type PricingFixture = {
  offeringId: string;
  /** USD per million tokens; stored per-token, as the column requires. */
  inputUsdPerMTok: number | null;
  outputUsdPerMTok: number | null;
  currency?: string;
  effectiveFrom?: Date;
};

export function pricing(fixture: PricingFixture): ModelPricingRow {
  const perToken = (perMTok: number | null): string | null =>
    perMTok === null ? null : String(perMTok / 1_000_000);
  const effectiveFrom = fixture.effectiveFrom ?? EPOCH;
  return {
    id: `pricing-${fixture.offeringId}-${effectiveFrom.toISOString()}`,
    tenantId: "bench-1",
    offeringId: fixture.offeringId,
    currency: fixture.currency ?? "USD",
    inputTokenPrice: perToken(fixture.inputUsdPerMTok),
    outputTokenPrice: perToken(fixture.outputUsdPerMTok),
    cacheReadTokenPrice: null,
    cacheWriteTokenPrice: null,
    thinkingTokenPrice: null,
    perRequestFee: null,
    perImageFee: null,
    perAudioFee: null,
    effectiveFrom,
    createdAt: effectiveFrom,
  };
}
