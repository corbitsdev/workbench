import { describe, expect, test } from "bun:test";
import type { ProviderPreference } from "@intx/types";

import { offering, pricing } from "../test/fixtures";
import { EMPTY_POLICY, type BenchModelPolicy } from "./policy";
import {
  chainToModelRequirements,
  resolveModelChain,
  UnknownConceptError,
  type ResolveChainInput,
} from "./resolve-chain";

const ASOF = new Date("2026-06-01T00:00:00.000Z");

const CHEAP_LOOP_CAPABLE = ["plain-text", "structured-output"] as const;

function input(overrides: Partial<ResolveChainInput>): ResolveChainInput {
  return {
    need: { concept: "cheap-loop" },
    offerings: [],
    pricing: [],
    policy: EMPTY_POLICY,
    asOf: ASOF,
    ...overrides,
  };
}

function policy(overrides: Partial<BenchModelPolicy>): BenchModelPolicy {
  return { ...EMPTY_POLICY, ...overrides };
}

describe("resolveModelChain: the need", () => {
  test("a concept nobody shipped is an error that names the real ones", () => {
    expect(() =>
      resolveModelChain(input({ need: { concept: "vibes-based" } })),
    ).toThrow(UnknownConceptError);
    try {
      resolveModelChain(input({ need: { concept: "vibes-based" } }));
    } catch (err) {
      expect((err as Error).message).toContain("cheap-loop");
    }
  });

  test("a bare capability ask filters on exactly those capabilities", () => {
    const chain = resolveModelChain(
      input({
        need: { capabilities: ["vision-input"] },
        offerings: [
          offering({
            id: "o1",
            canonicalName: "sees-things",
            providerName: "acme",
            capabilities: ["vision-input", "plain-text"],
          }),
          offering({
            id: "o2",
            canonicalName: "text-only",
            providerName: "acme",
            capabilities: ["plain-text"],
          }),
        ],
      }),
    );
    expect(chain.concept).toBeNull();
    expect(chain.entries.map((entry) => entry.offeringId)).toEqual(["o1"]);
    expect(chain.excluded).toEqual([
      { offeringId: "o2", reason: "missing-capabilities" },
    ]);
  });
});

describe("resolveModelChain: what qualifies", () => {
  test("a capability the concept requires must be advertised, not merely close", () => {
    const chain = resolveModelChain(
      input({
        need: { concept: "bulk-extraction" },
        offerings: [
          offering({
            id: "o1",
            canonicalName: "half-capable",
            providerName: "acme",
            capabilities: ["plain-text"],
          }),
        ],
      }),
    );
    expect(chain.entries).toEqual([]);
    expect(chain.excluded).toEqual([
      { offeringId: "o1", reason: "missing-capabilities" },
    ]);
  });

  test("a provider with no credential is not something this bench can reach", () => {
    const chain = resolveModelChain(
      input({
        offerings: [
          offering({
            id: "o1",
            canonicalName: "unreachable",
            providerName: "acme",
            capabilities: [...CHEAP_LOOP_CAPABLE],
            connected: false,
          }),
        ],
      }),
    );
    expect(chain.entries).toEqual([]);
    expect(chain.excluded).toEqual([
      { offeringId: "o1", reason: "provider-not-connected" },
    ]);
  });
});

describe("resolveModelChain: policy selectors", () => {
  const offerings = [
    offering({
      id: "o1",
      canonicalName: "alpha",
      providerName: "acme",
      capabilities: [...CHEAP_LOOP_CAPABLE],
    }),
    offering({
      id: "o2",
      canonicalName: "beta",
      providerName: "globex",
      capabilities: [...CHEAP_LOOP_CAPABLE],
    }),
  ];

  test("deny by exact model name", () => {
    const chain = resolveModelChain(
      input({ offerings, policy: policy({ deny: ["alpha"] }) }),
    );
    expect(chain.entries.map((entry) => entry.canonicalName)).toEqual(["beta"]);
    expect(chain.policyApplied.deny).toBe(true);
  });

  test("deny a whole provider", () => {
    const chain = resolveModelChain(
      input({ offerings, policy: policy({ deny: ["provider:globex"] }) }),
    );
    expect(chain.entries.map((entry) => entry.canonicalName)).toEqual([
      "alpha",
    ]);
  });

  test("deny one deployment of a model, by provider/model", () => {
    const chain = resolveModelChain(
      input({ offerings, policy: policy({ deny: ["acme/alpha"] }) }),
    );
    expect(chain.entries.map((entry) => entry.offeringId)).toEqual(["o2"]);
  });

  test("a non-empty allow list is the whole world", () => {
    const chain = resolveModelChain(
      input({ offerings, policy: policy({ allow: ["beta"] }) }),
    );
    expect(chain.entries.map((entry) => entry.canonicalName)).toEqual(["beta"]);
    expect(chain.excluded).toEqual([
      { offeringId: "o1", reason: "outside-policy-allow" },
    ]);
  });

  test("an empty allow list constrains nothing", () => {
    const chain = resolveModelChain(input({ offerings }));
    expect(chain.entries.length).toBe(2);
    expect(chain.policyApplied.allow).toBe(false);
  });
});

describe("resolveModelChain: price and ordering", () => {
  const offerings = [
    offering({
      id: "expensive",
      canonicalName: "alpha",
      providerName: "acme",
      capabilities: [...CHEAP_LOOP_CAPABLE],
      priority: 0,
    }),
    offering({
      id: "cheap",
      canonicalName: "beta",
      providerName: "globex",
      capabilities: [...CHEAP_LOOP_CAPABLE],
      priority: 10,
    }),
  ];
  const prices = [
    pricing({
      offeringId: "expensive",
      inputUsdPerMTok: 0.2,
      outputUsdPerMTok: 0.9,
    }),
    pricing({
      offeringId: "cheap",
      inputUsdPerMTok: 0.05,
      outputUsdPerMTok: 0.2,
    }),
  ];

  test("cheapest first uses the concept's own token mix", () => {
    const chain = resolveModelChain(input({ offerings, pricing: prices }));
    expect(chain.entries.map((entry) => entry.offeringId)).toEqual([
      "cheap",
      "expensive",
    ]);
    expect(chain.entries[0]?.price.inputUsdPerMTok).toBeCloseTo(0.05, 8);
    expect(chain.entries[0]?.referenceCostUsd).toBeCloseTo(0.06, 8);
  });

  test("catalog order puts the catalog's own priority first", () => {
    const chain = resolveModelChain(
      input({ offerings, pricing: prices, order: "catalog" }),
    );
    expect(chain.entries.map((entry) => entry.offeringId)).toEqual([
      "expensive",
      "cheap",
    ]);
  });

  test("an unpriced model sorts behind every priced one and is never called free", () => {
    const chain = resolveModelChain(
      input({
        offerings: [
          ...offerings,
          offering({
            id: "unpriced",
            canonicalName: "gamma",
            providerName: "initech",
            capabilities: [...CHEAP_LOOP_CAPABLE],
          }),
        ],
        pricing: prices,
      }),
    );
    expect(chain.entries.map((entry) => entry.offeringId)).toEqual([
      "cheap",
      "expensive",
      "unpriced",
    ]);
    const unpriced = chain.entries[2];
    expect(unpriced?.price.known).toBe(false);
    expect(unpriced?.referenceCostUsd).toBeNull();
  });

  test("equal cost and priority break ties by name, provider, then id", () => {
    const chain = resolveModelChain(
      input({
        offerings: [
          offering({
            id: "z",
            canonicalName: "same",
            providerName: "zulu",
            capabilities: [...CHEAP_LOOP_CAPABLE],
          }),
          offering({
            id: "a",
            canonicalName: "same",
            providerName: "alpha",
            capabilities: [...CHEAP_LOOP_CAPABLE],
          }),
          offering({
            id: "m",
            canonicalName: "earlier",
            providerName: "mike",
            capabilities: [...CHEAP_LOOP_CAPABLE],
          }),
        ],
        pricing: [
          pricing({
            offeringId: "z",
            inputUsdPerMTok: 0.1,
            outputUsdPerMTok: 0.1,
          }),
          pricing({
            offeringId: "a",
            inputUsdPerMTok: 0.1,
            outputUsdPerMTok: 0.1,
          }),
          pricing({
            offeringId: "m",
            inputUsdPerMTok: 0.1,
            outputUsdPerMTok: 0.1,
          }),
        ],
      }),
    );
    expect(chain.entries.map((entry) => entry.offeringId)).toEqual([
      "m",
      "a",
      "z",
    ]);
  });
});

describe("resolveModelChain: ceilings", () => {
  const overCeiling = offering({
    id: "lavish",
    canonicalName: "lavish",
    providerName: "acme",
    capabilities: [...CHEAP_LOOP_CAPABLE],
  });
  const withinCeiling = offering({
    id: "thrifty",
    canonicalName: "thrifty",
    providerName: "globex",
    capabilities: [...CHEAP_LOOP_CAPABLE],
  });
  const prices = [
    pricing({
      offeringId: "lavish",
      inputUsdPerMTok: 30,
      outputUsdPerMTok: 60,
    }),
    pricing({
      offeringId: "thrifty",
      inputUsdPerMTok: 0.1,
      outputUsdPerMTok: 0.4,
    }),
  ];

  test("a concept ceiling flags and demotes, it never drops", () => {
    const chain = resolveModelChain(
      input({ offerings: [overCeiling, withinCeiling], pricing: prices }),
    );
    expect(chain.entries.map((entry) => entry.offeringId)).toEqual([
      "thrifty",
      "lavish",
    ]);
    expect(chain.entries[0]?.overCeiling).toBe(false);
    expect(chain.entries[1]?.overCeiling).toBe(true);
  });

  test("a bench with only an over-ceiling model still gets a chain", () => {
    const chain = resolveModelChain(
      input({ offerings: [overCeiling], pricing: prices }),
    );
    expect(chain.entries.map((entry) => entry.offeringId)).toEqual(["lavish"]);
    expect(chain.entries[0]?.overCeiling).toBe(true);
  });

  test("a hard bench ceiling excludes and says so", () => {
    const chain = resolveModelChain(
      input({
        offerings: [overCeiling, withinCeiling],
        pricing: prices,
        policy: policy({
          maxInputUsdPerMTok: 1,
          maxOutputUsdPerMTok: 5,
          ceilingIsHard: true,
        }),
      }),
    );
    expect(chain.entries.map((entry) => entry.offeringId)).toEqual(["thrifty"]);
    expect(chain.excluded).toEqual([
      { offeringId: "lavish", reason: "over-bench-ceiling" },
    ]);
    expect(chain.policyApplied.ceiling).toBe("hard");
  });

  test("a raised concept ceiling brings a model back within budget", () => {
    const chain = resolveModelChain(
      input({
        offerings: [overCeiling],
        pricing: prices,
        policy: policy({
          conceptCeilings: {
            "cheap-loop": { maxInputUsdPerMTok: 50, maxOutputUsdPerMTok: 100 },
          },
        }),
      }),
    );
    expect(chain.entries[0]?.overCeiling).toBe(false);
  });

  test("an unpriced model is never over ceiling — it is simply unknown", () => {
    const chain = resolveModelChain(
      input({
        offerings: [
          offering({
            id: "mystery",
            canonicalName: "mystery",
            providerName: "acme",
            capabilities: [...CHEAP_LOOP_CAPABLE],
          }),
        ],
        policy: policy({ maxInputUsdPerMTok: 0.01, ceilingIsHard: true }),
      }),
    );
    expect(chain.entries.map((entry) => entry.offeringId)).toEqual(["mystery"]);
    expect(chain.entries[0]?.overCeiling).toBe(false);
  });
});

describe("resolveModelChain: provider preference", () => {
  const offerings = [
    offering({
      id: "o1",
      canonicalName: "alpha",
      providerName: "acme",
      capabilities: [...CHEAP_LOOP_CAPABLE],
    }),
    offering({
      id: "o2",
      canonicalName: "beta",
      providerName: "globex",
      capabilities: [...CHEAP_LOOP_CAPABLE],
    }),
  ];

  test("pin keeps only the named providers", () => {
    const chain = resolveModelChain(
      input({
        offerings,
        policy: policy({
          providerPreference: { mode: "pin", order: ["globex"] },
        }),
      }),
    );
    expect(chain.entries.map((entry) => entry.providerName)).toEqual([
      "globex",
    ]);
    expect(chain.policyApplied.providerPreference).toBe("pin");
  });

  test("prefer fronts the named providers and keeps the rest as fallback", () => {
    const chain = resolveModelChain(
      input({
        offerings,
        policy: policy({
          providerPreference: { mode: "prefer", order: ["globex"] },
        }),
      }),
    );
    expect(chain.entries.map((entry) => entry.providerName)).toEqual([
      "globex",
      "acme",
    ]);
  });
});

describe("resolveModelChain: the chain itself", () => {
  test("the last slot goes to another provider when one exists", () => {
    const chain = resolveModelChain(
      input({
        limit: 2,
        offerings: [
          offering({
            id: "a1",
            canonicalName: "a1",
            providerName: "acme",
            capabilities: [...CHEAP_LOOP_CAPABLE],
            priority: 0,
          }),
          offering({
            id: "a2",
            canonicalName: "a2",
            providerName: "acme",
            capabilities: [...CHEAP_LOOP_CAPABLE],
            priority: 1,
          }),
          offering({
            id: "b1",
            canonicalName: "b1",
            providerName: "globex",
            capabilities: [...CHEAP_LOOP_CAPABLE],
            priority: 2,
          }),
        ],
      }),
    );
    expect(chain.diversified).toBe(true);
    expect(chain.entries.map((entry) => entry.providerName)).toEqual([
      "acme",
      "globex",
    ]);
  });

  test("a single-provider bench is not falsely diversified", () => {
    const chain = resolveModelChain(
      input({
        limit: 2,
        offerings: [
          offering({
            id: "a1",
            canonicalName: "a1",
            providerName: "acme",
            capabilities: [...CHEAP_LOOP_CAPABLE],
          }),
          offering({
            id: "a2",
            canonicalName: "a2",
            providerName: "acme",
            capabilities: [...CHEAP_LOOP_CAPABLE],
            priority: 1,
          }),
        ],
      }),
    );
    expect(chain.diversified).toBe(false);
    expect(chain.entries.length).toBe(2);
  });

  test("a fresh bench with one connected provider and no policy still answers", () => {
    const chain = resolveModelChain({
      need: { concept: "cheap-loop" },
      offerings: [
        offering({
          id: "only",
          canonicalName: "only-model",
          providerName: "acme",
          capabilities: [...CHEAP_LOOP_CAPABLE],
        }),
      ],
      pricing: [],
      policy: EMPTY_POLICY,
      asOf: ASOF,
    });
    expect(chain.entries.map((entry) => entry.canonicalName)).toEqual([
      "only-model",
    ]);
    expect(chain.policyApplied).toEqual({
      allow: false,
      deny: false,
      ceiling: "none",
      providerPreference: "none",
    });
  });

  test("an empty chain comes back with its reasons, never a stand-in model", () => {
    const chain = resolveModelChain(
      input({
        need: { concept: "image-maker" },
        offerings: [
          offering({
            id: "o1",
            canonicalName: "words-only",
            providerName: "acme",
            capabilities: ["plain-text"],
          }),
        ],
      }),
    );
    expect(chain.entries).toEqual([]);
    expect(chain.excluded).toEqual([
      { offeringId: "o1", reason: "missing-capabilities" },
    ]);
  });

  test("provenance records whether the offering was set here or inherited", () => {
    const chain = resolveModelChain(
      input({
        offerings: [
          offering({
            id: "o1",
            canonicalName: "inherited-model",
            providerName: "acme",
            capabilities: [...CHEAP_LOOP_CAPABLE],
            inherited: true,
          }),
        ],
      }),
    );
    expect(chain.entries[0]?.provenance).toBe("inherited");
  });
});

describe("chainToModelRequirements", () => {
  test("one requirement per canonical model, in chain order", () => {
    const chain = resolveModelChain(
      input({
        offerings: [
          offering({
            id: "o1",
            canonicalName: "shared",
            providerName: "acme",
            capabilities: [...CHEAP_LOOP_CAPABLE],
          }),
          offering({
            id: "o2",
            canonicalName: "shared",
            providerName: "globex",
            capabilities: [...CHEAP_LOOP_CAPABLE],
          }),
          offering({
            id: "o3",
            canonicalName: "other",
            providerName: "globex",
            capabilities: [...CHEAP_LOOP_CAPABLE],
          }),
        ],
      }),
    );
    const requirements = chainToModelRequirements(chain, null);
    expect(requirements.map((requirement) => requirement.model)).toEqual([
      "other",
      "shared",
    ]);
    expect(requirements[0]?.capabilities).toEqual(["plain-text"]);
  });

  test("a pinned provider preference rides along on every requirement", () => {
    const chain = resolveModelChain(
      input({
        offerings: [
          offering({
            id: "o1",
            canonicalName: "alpha",
            providerName: "acme",
            capabilities: [...CHEAP_LOOP_CAPABLE],
          }),
        ],
      }),
    );
    const preference: ProviderPreference = { mode: "pin", order: ["acme"] };
    const requirements = chainToModelRequirements(chain, preference);
    expect(requirements[0]?.providers).toEqual(preference);
  });
});
