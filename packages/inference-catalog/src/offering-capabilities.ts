// What a deployment can actually do, resolved from the pinned catalog at the
// moment an offering is created.
//
// `model_offering.capabilities` is the column every capability filter reads —
// this package's chain resolution and the platform's own source resolution
// alike. Nothing populated it before, so it was empty everywhere and no
// capability question had an answer. This module is where the answer comes
// from, and it only ever reports capabilities the pinned catalog observed on
// the wire:
//
//   exact-deployment  — this exact (baseURL, model) was probed. Use its list.
//   same-model-wire   — the model was probed on other deployments that speak
//                       the same wire, and this one is a relay of it. Use the
//                       INTERSECTION across those deployments, so a relay
//                       never claims more than every probed deployment of
//                       that model demonstrated.
//   unknown           — no probe covers it. Empty list, said plainly.
//
// An empty list is the honest answer for a local or open-weight deployment
// nobody has probed, and it is deliberately not softened with a per-adapter
// baseline: "an OpenAI-compatible endpoint serves plain text" is false for
// the embedding models such endpoints also serve, and a wrong capability tag
// routes real work to a model that cannot do it.
// The pinned catalog's own vocabulary is a superset of what the platform can
// store: it bakes `long-context` and `prompt-caching`, which `@intx/types`'
// `Capability` — the arktype guarding the offerings API and the column — does
// not accept. Everything this module reports is filtered down to the storable
// vocabulary, so a seed never posts a value the hub will reject.
import { catalogProviders } from "@intx/inference-catalog";
import { WIRE_CAPABILITIES, type Capability } from "@intx/types";

export type CapabilityProvenance =
  "exact-deployment" | "same-model-wire" | "unknown";

export type OfferingCapabilities = {
  readonly capabilities: readonly Capability[];
  readonly provenance: CapabilityProvenance;
};

export type DeploymentIdentity = {
  /** The adapter that serves this provider, as stored on `model_provider`. */
  readonly plugin: string;
  readonly baseURL: string;
  readonly canonicalName: string;
};

/** OpenAI Direct and every openai-compatible relay speak one wire, so a model
 * probed on one is speaking the same protocol on the other. The Anthropic and
 * Google adapters each speak their own wire: a relay serving a Claude model
 * over the OpenAI wire genuinely offers less than the native adapter does, so
 * their probes never carry across. */
function wireFamily(plugin: string): string {
  return plugin === "openai" || plugin === "openai-compatible"
    ? "openai-wire"
    : plugin;
}

/** Relays namespace a model by its originating vendor (`openai/gpt-5.6-sol`,
 * `deepseek-ai/DeepSeek-V4-Flash`). The trailing segment is the model the
 * catalog probed. */
function relayModelName(canonicalName: string): string {
  const lastSlash = canonicalName.lastIndexOf("/");
  return lastSlash === -1 ? canonicalName : canonicalName.slice(lastSlash + 1);
}

function intersect(lists: readonly (readonly string[])[]): readonly string[] {
  const [first, ...rest] = lists;
  if (first === undefined) return [];
  return first.filter((capability) =>
    rest.every((list) => list.includes(capability)),
  );
}

const STORABLE = new Set<string>(WIRE_CAPABILITIES);

function storable(capabilities: readonly string[]): readonly Capability[] {
  return capabilities.filter((capability): capability is Capability =>
    STORABLE.has(capability),
  );
}

/**
 * The capabilities to store on a newly created offering. Deterministic and
 * dependency-free: it reads the pinned catalog literals only, never a
 * network probe.
 */
export function capabilitiesForDeployment(
  deployment: DeploymentIdentity,
): OfferingCapabilities {
  for (const provider of catalogProviders) {
    if (provider.baseURL !== deployment.baseURL) continue;
    const offering = provider.offerings.find(
      (candidate) => candidate.model === deployment.canonicalName,
    );
    if (offering !== undefined) {
      return {
        capabilities: storable(offering.capabilities),
        provenance: "exact-deployment",
      };
    }
  }

  const family = wireFamily(deployment.plugin);
  const modelName = relayModelName(deployment.canonicalName);
  const sameWire: (readonly string[])[] = [];
  for (const provider of catalogProviders) {
    if (wireFamily(provider.plugin) !== family) continue;
    for (const offering of provider.offerings) {
      if (offering.model === modelName) sameWire.push(offering.capabilities);
    }
  }
  if (sameWire.length > 0) {
    return {
      capabilities: storable(intersect(sameWire)),
      provenance: "same-model-wire",
    };
  }

  return { capabilities: [], provenance: "unknown" };
}
