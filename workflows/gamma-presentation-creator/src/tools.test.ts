import { describe, expect, it } from "bun:test";
import { createGammaPresentationCreatorTools } from "./tools";
import { toolManifestFile } from "./tool-manifest";

const SIGNAL = new AbortController().signal;

function findTool(name: string) {
  const tool = createGammaPresentationCreatorTools().find(
    (t) => t.definition.name === name,
  );
  if (!tool || tool.kind !== "full") {
    throw new Error(`${name} not registered as a full tool`);
  }
  return tool;
}

describe("gamma_presentation_creator_prepare_render", () => {
  it("renames the draft agent's reply to gamma_create_from_template's prompt argument", async () => {
    const tool = findTool("gamma_presentation_creator_prepare_render");
    const result = await tool.handler(
      {
        id: "call_1",
        name: "gamma_presentation_creator_prepare_render",
        arguments: { gammaId: "tmpl_1", reply: "SLIDE 1: v1" },
      },
      SIGNAL,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual({
      gammaId: "tmpl_1",
      prompt: "SLIDE 1: v1",
    });
  });

  it("errors when gammaId is missing", async () => {
    const tool = findTool("gamma_presentation_creator_prepare_render");
    const result = await tool.handler(
      {
        id: "call_2",
        name: "gamma_presentation_creator_prepare_render",
        arguments: { reply: "SLIDE 1: v1" },
      },
      SIGNAL,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe("gammaId is required");
  });

  it("errors when reply is missing", async () => {
    const tool = findTool("gamma_presentation_creator_prepare_render");
    const result = await tool.handler(
      {
        id: "call_3",
        name: "gamma_presentation_creator_prepare_render",
        arguments: { gammaId: "tmpl_1" },
      },
      SIGNAL,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe("reply is required");
  });

  it("falls back to the _raw JSON envelope", async () => {
    const tool = findTool("gamma_presentation_creator_prepare_render");
    const result = await tool.handler(
      {
        id: "call_4",
        name: "gamma_presentation_creator_prepare_render",
        arguments: {
          _raw: JSON.stringify({ gammaId: "tmpl_2", reply: "draft" }),
        },
      },
      SIGNAL,
    );

    expect(result.content).toEqual({ gammaId: "tmpl_2", prompt: "draft" });
  });
});

describe("gamma_presentation_creator_prepare_persist", () => {
  const baseArgs = {
    deckTitle: "Q3 Deck",
    reply: "A deck about v1",
    url: "https://gamma.app/docs/1",
    gammaId: "deck_1",
    exportUrl: "https://gamma.app/export/1.pdf",
  };

  it("pairs the intake title, the describe summary, and the deck fields into the persist tool's argument names", async () => {
    const tool = findTool("gamma_presentation_creator_prepare_persist");
    const result = await tool.handler(
      {
        id: "call_1",
        name: "gamma_presentation_creator_prepare_persist",
        arguments: baseArgs,
      },
      SIGNAL,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual({
      title: "Q3 Deck",
      description: "A deck about v1",
      url: "https://gamma.app/docs/1",
      gammaId: "deck_1",
      pdfUrl: "https://gamma.app/export/1.pdf",
    });
  });

  it("defaults pdfUrl to an empty string when exportUrl is absent", async () => {
    const tool = findTool("gamma_presentation_creator_prepare_persist");
    const { exportUrl: _exportUrl, ...rest } = baseArgs;
    const result = await tool.handler(
      {
        id: "call_2",
        name: "gamma_presentation_creator_prepare_persist",
        arguments: rest,
      },
      SIGNAL,
    );

    expect(result.content).toMatchObject({ pdfUrl: "" });
  });

  it("errors when a required field is missing", async () => {
    const tool = findTool("gamma_presentation_creator_prepare_persist");
    const { deckTitle: _deckTitle, ...rest } = baseArgs;
    const result = await tool.handler(
      {
        id: "call_3",
        name: "gamma_presentation_creator_prepare_persist",
        arguments: rest,
      },
      SIGNAL,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe("deckTitle is required");
  });

  it("falls back to the _raw JSON envelope", async () => {
    const tool = findTool("gamma_presentation_creator_prepare_persist");
    const result = await tool.handler(
      {
        id: "call_4",
        name: "gamma_presentation_creator_prepare_persist",
        arguments: { _raw: JSON.stringify(baseArgs) },
      },
      SIGNAL,
    );

    expect(result.content).toMatchObject({ title: "Q3 Deck" });
  });
});

describe("tool-manifest", () => {
  it("registers both shaping tools under the gamma-presentation-creator factory", () => {
    const factory = toolManifestFile.factories[0];
    expect(factory?.factoryId).toBe(
      "@workbench/workflow-gamma-presentation-creator/core",
    );
    expect(factory?.bareToolNames).toEqual([
      "gamma_presentation_creator_prepare_persist",
      "gamma_presentation_creator_prepare_render",
    ]);
  });
});
