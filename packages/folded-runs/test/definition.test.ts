// Proves `readFoldedBody`'s validation of a parsed folded
// `WorkflowDefinition`: it extracts the launch-relevant subset of a
// single-step definition's step, and fails loud on a malformed
// definition, a multi-step one, or a step that isn't a step primitive
// — rather than casting an untyped blob into `@intx/workflow`'s real
// (function-bearing) `WorkflowDefinition` type. Also proves
// `resolveNewestReadableDefinitionJSON` (CL-6357): a stale asset whose
// ref no longer resolves must never win over a healthy newer one, and
// exhausting every candidate raises the named
// `DefinitionAssetUnresolvableError` rather than letting the last raw
// read failure escape.
import { describe, expect, test } from "bun:test";
import type { AssetService } from "@intx/hub-sessions";
import {
  readFoldedBody,
  resolveNewestReadableDefinitionJSON,
  DefinitionAssetUnresolvableError,
} from "../src/definition";

function fakeAssetService(
  blobsByAssetId: Record<string, unknown>,
): AssetService {
  return {
    readAssetBlob: async ({ assetId }: { assetId: string; path: string }) => {
      if (!(assetId in blobsByAssetId)) {
        throw new Error(`readAssetBlob: refs/heads/main not resolvable`);
      }
      return new TextEncoder().encode(JSON.stringify(blobsByAssetId[assetId]));
    },
  } as unknown as AssetService;
}

function foldedDefinition(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "wfd_1",
    stepOrder: ["host"],
    steps: {
      host: {
        kind: "step",
        agent: {
          systemPrompt: "you are a workbench host",
          toolPackagePins: [],
          inference: { sources: [{ model: "claude-sonnet-5" }] },
        },
      },
    },
    grantRequirements: [],
    credentialBindings: [],
    ...overrides,
  };
}

describe("readFoldedBody", () => {
  test("extracts the launch-relevant subset of a valid single-step definition", () => {
    const body = readFoldedBody(foldedDefinition());
    expect(body).toEqual({
      systemPrompt: "you are a workbench host",
      toolPackagePins: [],
      grantRequirements: [],
      credentialBindings: [],
      model: "claude-sonnet-5",
    });
  });

  test("fails loud on a malformed definition", () => {
    expect(() => readFoldedBody({ not: "a definition" })).toThrow(
      /folded definition is malformed/,
    );
  });

  test("fails loud on a multi-step definition", () => {
    const definition = foldedDefinition({ stepOrder: ["host", "second"] });
    expect(() => readFoldedBody(definition)).toThrow(/not single-step/);
  });

  test("fails loud when the named step is not a step primitive", () => {
    const definition = foldedDefinition({
      steps: { host: { kind: "not-a-step" } },
    });
    expect(() => readFoldedBody(definition)).toThrow(/is not a step primitive/);
  });
});

describe("resolveNewestReadableDefinitionJSON", () => {
  test("prefers the newest asset whose ref actually resolves over a stale unresolvable one", async () => {
    const healthy = foldedDefinition({ id: "wfd_new" });
    const assetService = fakeAssetService({ ast_new: healthy });

    const resolved = await resolveNewestReadableDefinitionJSON(assetService, [
      // Newest first, as the caller orders candidates by createdAt desc.
      { assetId: "ast_stale", definitionName: "assistant" },
      { assetId: "ast_new", definitionName: "assistant" },
    ]);

    expect(resolved.assetId).toBe("ast_new");
    expect(resolved.definitionJSON).toEqual(healthy);
  });

  test("resolves the first candidate directly when it is already healthy", async () => {
    const healthy = foldedDefinition({ id: "wfd_head" });
    const assetService = fakeAssetService({ ast_head: healthy });

    const resolved = await resolveNewestReadableDefinitionJSON(assetService, [
      { assetId: "ast_head", definitionName: "assistant" },
    ]);

    expect(resolved.assetId).toBe("ast_head");
  });

  test("raises DefinitionAssetUnresolvableError when no candidate resolves", async () => {
    const assetService = fakeAssetService({});

    await expect(
      resolveNewestReadableDefinitionJSON(assetService, [
        { assetId: "ast_dead_1", definitionName: "assistant" },
        { assetId: "ast_dead_2", definitionName: "assistant" },
      ]),
    ).rejects.toThrow(DefinitionAssetUnresolvableError);
  });

  test("raises DefinitionAssetUnresolvableError with consumer-language guidance when there are no candidates at all", async () => {
    const assetService = fakeAssetService({});

    await expect(
      resolveNewestReadableDefinitionJSON(assetService, []),
    ).rejects.toThrow(/re-publishing/);
  });
});
