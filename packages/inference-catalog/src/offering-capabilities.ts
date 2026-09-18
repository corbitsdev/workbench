// What a deployment can actually do, resolved from the pinned catalog at the
// moment an offering is created. Full rationale: docs/offering-capabilities.md.
import { catalogProviders } from "@intx/inference-catalog";
import { WIRE_CAPABILITIES, type Capability } from "@intx/types";

export type CapabilityProvenance = "exact-deployment" | "same-model-wire" | "unknown";

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

/** OpenAI Direct and every openai-compatible relay speak one wire; other
 * adapters speak their own, since a relay genuinely offers less. */
function wireFamily(plugin: string): string {
  return plugin === "openai" || plugin === "openai-compatible" ? "openai-wire" : plugin;
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
  return first.filter((capability) => rest.every((list) => list.includes(capability)));
}

const STORABLE = new Set<string>(WIRE_CAPABILITIES);

function storable(capabilities: readonly string[]): readonly Capability[] {
  return capabilities.filter((capability): capability is Capability => STORABLE.has(capability));
}

/**
 * The capabilities to store on a newly created offering. Deterministic and
 * dependency-free: it reads the pinned catalog literals only, never a
 * network probe.
 */
export function capabilitiesForDeployment(deployment: DeploymentIdentity): OfferingCapabilities {
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
