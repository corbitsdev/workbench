// Proves the two launch-body readers and the projection resolver.
//
// `readFoldedBody` reads the INERT projection the deploy freeze
// persisted (`agent.modelSources`, no `grantRequirements` — the
// projector drops it, so the definition row supplies it), and fails
// loud on a malformed projection, a multi-step one, or a step that is
// not a step primitive. `readLiveFoldedBody` reads the pre-projection
// live shape the in-process workbench-host launch still carries.
//
// `resolveNewestProjectedDefinition` is the DB-side successor to
// CL-6357's asset-drift walk: a pre-cutover sibling carrying no stored
// projection must never win over a healthy newer one, and exhausting
// every candidate raises the named `DefinitionProjectionMissingError`.
import { describe, expect, mock, test } from "bun:test";

const projectionsById: Record<string, unknown> = {};
mock.module("@intx/db", () => ({
  loadFrozenWireProjection: async (_db: unknown, definitionId: string) =>
    projectionsById[definitionId] ?? null,
}));

const {
  authoredDefinitionCandidates,
  readFoldedBody,
  readLiveFoldedBody,
  readDefinitionProjection,
  resolveNewestProjectedDefinition,
  DefinitionProjectionMissingError,
} = await import("../src/definition");

function inertProjection(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "wfd_1",
    stepOrder: ["host"],
    steps: {
      host: {
        kind: "step",
        agent: {
          systemPrompt: "you are a workbench host",
          toolPackagePins: [],
          modelSources: [{ provider: "ollama", model: "qwen3:8b" }],
        },
      },
    },
    credentialBindings: [],
    ...overrides,
  };
}

function sectionProjection(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "wfd_2",
    stepOrder: ["turn"],
    steps: {
      turn: {
        kind: "onTrigger",
        id: "turn",
        on: { type: "mail", to: "agent@example.com" },
        onBodyFailure: "continue",
        body: {
          inline: {
            id: "wfd_2_body",
            stepOrder: ["reply"],
            steps: {
              reply: {
                kind: "step",
                agent: {
                  systemPrompt: "you are the invited agent",
                  toolPackagePins: [],
                  modelSources: [{ provider: "ollama", model: "qwen3:8b" }],
                },
              },
            },
          },
        },
      },
    },
    credentialBindings: [],
    ...overrides,
  };
}

function liveDefinition(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "wfd_live",
    stepOrder: ["host"],
    steps: {
      host: {
        kind: "step",
        agent: {
          systemPrompt: "you are a workbench host",
          toolPackagePins: [],
          inference: { sources: [{ model: "qwen3:8b" }] },
        },
      },
    },
    grantRequirements: [],
    credentialBindings: [],
    ...overrides,
  };
}

describe("readFoldedBody", () => {
  test("extracts the launch body from an inert projection plus the row's grant requirements", () => {
    expect(readFoldedBody(inertProjection(), [])).toEqual({
      systemPrompt: "you are a workbench host",
      toolPackagePins: [],
      grantRequirements: [],
      credentialBindings: [],
      model: "qwen3:8b",
    });
  });

  test("takes grant requirements from the definition row, which the projection never carries", () => {
    const requirement = {
      resource: "tool:search",
      action: "invoke",
      source: "creator" as const,
    };
    const body = readFoldedBody(inertProjection(), [requirement]);
    expect(body.grantRequirements).toEqual([requirement]);
  });

  test("fails loud on a malformed projection", () => {
    expect(() => readFoldedBody({ not: "a projection" }, [])).toThrow(
      /inert projection is malformed/,
    );
  });

  test("fails loud on a multi-step projection", () => {
    expect(() =>
      readFoldedBody(inertProjection({ stepOrder: ["host", "second"] }), []),
    ).toThrow(/not single-step/);
  });

  test("fails loud when the named step is not a step primitive", () => {
    expect(() =>
      readFoldedBody(
        inertProjection({ steps: { host: { kind: "not-a-step" } } }),
        [],
      ),
    ).toThrow(/is not a step primitive/);
  });

  test("rejects a LIVE definition, whose inference chain the projection flattens away", () => {
    expect(() => readFoldedBody(liveDefinition(), [])).toThrow(
      /is not a step primitive/,
    );
  });

  test("extracts the launch body from a section-shaped (CL-6329 onTrigger) projection", () => {
    expect(readFoldedBody(sectionProjection(), [])).toEqual({
      systemPrompt: "you are the invited agent",
      toolPackagePins: [],
      grantRequirements: [],
      credentialBindings: [],
      model: "qwen3:8b",
    });
  });

  test("fails loud when a section's inline body is not single-step", () => {
    expect(() =>
      readFoldedBody(
        sectionProjection({
          steps: {
            turn: {
              kind: "onTrigger",
              body: {
                inline: {
                  id: "wfd_2_body",
                  stepOrder: ["reply", "second"],
                  steps: {},
                },
              },
            },
          },
        }),
        [],
      ),
    ).toThrow(/body is not single-step/);
  });

  test("fails loud when a section's inline body step is not a step primitive", () => {
    expect(() =>
      readFoldedBody(
        sectionProjection({
          steps: {
            turn: {
              kind: "onTrigger",
              body: {
                inline: {
                  id: "wfd_2_body",
                  stepOrder: ["reply"],
                  steps: { reply: { kind: "not-a-step" } },
                },
              },
            },
          },
        }),
        [],
      ),
    ).toThrow(/body step reply is not a step primitive/);
  });
});

describe("readLiveFoldedBody", () => {
  test("extracts the launch body from the in-process live definition shape", () => {
    expect(readLiveFoldedBody(liveDefinition())).toEqual({
      systemPrompt: "you are a workbench host",
      toolPackagePins: [],
      grantRequirements: [],
      credentialBindings: [],
      model: "qwen3:8b",
    });
  });

  test("fails loud on a malformed definition", () => {
    expect(() => readLiveFoldedBody({ not: "a definition" })).toThrow(
      /live definition is malformed/,
    );
  });
});

// CL-6452: every run deploy mints a same-named, same-asset sibling
// definition row (its per-run rendered bytes carry a per-run wire hash),
// frozen with the projection current AT THAT DEPLOY. Those run clones
// are deploy records, never launch candidates — only the hub-authored
// row, whose projection a skill pin or instructions save refreezes in
// place, may resolve a launch.
describe("authoredDefinitionCandidates", () => {
  test("keeps only the hub-authored row, dropping run-deploy clones", () => {
    const authored = {
      id: "wfd_authored",
      name: "fact-checker",
      origin: "authored",
    } as const;
    expect(
      authoredDefinitionCandidates([
        // Newest first: the clones every run deploy minted after the
        // agent was authored.
        { id: "wfd_run_2", name: "fact-checker", origin: "run" },
        { id: "wfd_run_1", name: "fact-checker", origin: "run" },
        authored,
      ]),
    ).toEqual([authored]);
  });

  test("N run deploys never grow the authoritative candidate set", () => {
    const authored = {
      id: "wfd_authored",
      name: "fact-checker",
      origin: "authored",
    } as const;
    const clones = Array.from({ length: 5 }, (_, index) => ({
      id: `wfd_run_${String(index + 1)}`,
      name: "fact-checker",
      origin: "run" as const,
    }));
    expect(authoredDefinitionCandidates([...clones, authored])).toHaveLength(1);
  });
});

describe("resolveNewestProjectedDefinition", () => {
  test("prefers the newest definition that actually carries a projection over a pre-cutover one", async () => {
    const healthy = inertProjection({ id: "wfd_new" });
    projectionsById["wfd_new"] = healthy;

    const resolved = await resolveNewestProjectedDefinition({} as never, [
      // Newest first, as the caller orders candidates by createdAt desc.
      { id: "wfd_pre_cutover", name: "assistant" },
      { id: "wfd_new", name: "assistant" },
    ]);

    expect(resolved.definitionId).toBe("wfd_new");
    expect(resolved.projection).toEqual(healthy);
  });

  test("raises DefinitionProjectionMissingError when no candidate carries one", async () => {
    await expect(
      resolveNewestProjectedDefinition({} as never, [
        { id: "wfd_dead_1", name: "assistant" },
        { id: "wfd_dead_2", name: "assistant" },
      ]),
    ).rejects.toThrow(DefinitionProjectionMissingError);
  });

  test("raises with consumer-language recovery guidance when there are no candidates at all", async () => {
    await expect(
      resolveNewestProjectedDefinition({} as never, []),
    ).rejects.toThrow(/save its instructions/);
  });
});

describe("readDefinitionProjection", () => {
  test("names the definition in the error a pre-cutover row raises", async () => {
    await expect(
      readDefinitionProjection({} as never, { id: "wfd_none", name: "myra" }),
    ).rejects.toThrow(/"myra"/);
  });
});
