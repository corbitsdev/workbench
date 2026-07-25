import { describe, expect, it } from "bun:test";
import { createProcessGranolaCallTools } from "./tools";
import { toolManifestFile } from "./tool-manifest";

const SIGNAL = new AbortController().signal;

function prepareDocumentTool() {
  const tool = createProcessGranolaCallTools().find(
    (t) => t.definition.name === "process_granola_prepare_document",
  );
  if (!tool || tool.kind !== "full") {
    throw new Error("prepare-document tool not registered as a full tool");
  }
  return tool;
}

const NOTE_JSON = JSON.stringify({ title: "Sync with Acme", transcript: "…" });

describe("process_granola_prepare_document", () => {
  it("extracts title from the note JSON and falls back to content as body", async () => {
    const tool = prepareDocumentTool();
    const result = await tool.handler(
      {
        id: "call_1",
        name: "process_granola_prepare_document",
        arguments: { content: NOTE_JSON, noteId: "note_1" },
      },
      SIGNAL,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual({
      title: "Sync with Acme",
      body: NOTE_JSON,
      sourceRefKey: "note_1",
    });
  });

  it("prefers reply as body when present", async () => {
    const tool = prepareDocumentTool();
    const result = await tool.handler(
      {
        id: "call_2",
        name: "process_granola_prepare_document",
        arguments: {
          content: NOTE_JSON,
          reply: "Working notes body",
          noteId: "note_1",
        },
      },
      SIGNAL,
    );

    expect(result.content).toEqual({
      title: "Sync with Acme",
      body: "Working notes body",
      sourceRefKey: "note_1",
    });
  });

  it("adds parentSourceRefKey only when includeParent is set", async () => {
    const tool = prepareDocumentTool();
    const result = await tool.handler(
      {
        id: "call_3",
        name: "process_granola_prepare_document",
        arguments: {
          content: NOTE_JSON,
          reply: "Final notes",
          noteId: "note_1",
          includeParent: true,
        },
      },
      SIGNAL,
    );

    expect(result.content).toEqual({
      title: "Sync with Acme",
      body: "Final notes",
      sourceRefKey: "note_1",
      parentSourceRefKey: "note_1",
    });
  });

  it("errors when content is missing", async () => {
    const tool = prepareDocumentTool();
    const result = await tool.handler(
      {
        id: "call_4",
        name: "process_granola_prepare_document",
        arguments: { noteId: "note_1" },
      },
      SIGNAL,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe("content is required");
  });

  it("errors when noteId is missing", async () => {
    const tool = prepareDocumentTool();
    const result = await tool.handler(
      {
        id: "call_5",
        name: "process_granola_prepare_document",
        arguments: { content: NOTE_JSON },
      },
      SIGNAL,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe("noteId is required");
  });

  it("errors when content is not valid JSON", async () => {
    const tool = prepareDocumentTool();
    const result = await tool.handler(
      {
        id: "call_6",
        name: "process_granola_prepare_document",
        arguments: { content: "not json", noteId: "note_1" },
      },
      SIGNAL,
    );

    expect(result.isError).toBe(true);
  });

  it("errors when the note JSON has no title", async () => {
    const tool = prepareDocumentTool();
    const result = await tool.handler(
      {
        id: "call_7",
        name: "process_granola_prepare_document",
        arguments: {
          content: JSON.stringify({ transcript: "…" }),
          noteId: "note_1",
        },
      },
      SIGNAL,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe("note JSON has no title");
  });

  it("falls back to the _raw JSON envelope", async () => {
    const tool = prepareDocumentTool();
    const result = await tool.handler(
      {
        id: "call_8",
        name: "process_granola_prepare_document",
        arguments: {
          _raw: JSON.stringify({ content: NOTE_JSON, noteId: "note_1" }),
        },
      },
      SIGNAL,
    );

    expect(result.content).toEqual({
      title: "Sync with Acme",
      body: NOTE_JSON,
      sourceRefKey: "note_1",
    });
  });
});

describe("tool-manifest", () => {
  it("registers process_granola_prepare_document under the process-granola-call factory", () => {
    const factory = toolManifestFile.factories[0];
    expect(factory?.factoryId).toBe(
      "@workbench/workflow-process-granola-call/core",
    );
    expect(factory?.bareToolNames).toEqual([
      "process_granola_prepare_document",
    ]);
  });
});
