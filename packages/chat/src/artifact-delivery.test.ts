import { describe, expect, test } from "bun:test";

import {
  artifactPartsForFinalizedTurn,
  artifactPartsForToolCall,
} from "./artifact-delivery";

describe("artifactPartsForToolCall", () => {
  test("returns a FilePart for a single persisted-artifact result", () => {
    const parts = artifactPartsForToolCall({
      isError: false,
      result: JSON.stringify({
        id: "art_1",
        version: 1,
        title: "Notes",
        kind: "text",
        persisted: true,
      }),
    });
    expect(parts).toEqual([
      {
        kind: "file",
        name: "Notes",
        mediaType: "text/plain",
        artifactId: "art_1",
      },
    ]);
  });

  test("returns one FilePart per artifact in a batched result", () => {
    const parts = artifactPartsForToolCall({
      isError: false,
      result: JSON.stringify({
        artifacts: [
          { id: "art_1", version: 1, title: "A", kind: "linkedin-post", persisted: true },
          { id: "art_2", version: 1, title: "B", kind: "text", persisted: true },
        ],
      }),
    });
    expect(parts).toEqual([
      {
        kind: "file",
        name: "A",
        mediaType: "application/octet-stream",
        artifactId: "art_1",
      },
      {
        kind: "file",
        name: "B",
        mediaType: "text/plain",
        artifactId: "art_2",
      },
    ]);
  });

  test("returns no parts for an errored tool call", () => {
    expect(
      artifactPartsForToolCall({
        isError: true,
        result: JSON.stringify({
          id: "art_1",
          version: 1,
          title: "Notes",
          kind: "text",
          persisted: true,
        }),
      }),
    ).toEqual([]);
  });

  test("returns no parts for unparseable JSON", () => {
    expect(
      artifactPartsForToolCall({ isError: false, result: "not json" }),
    ).toEqual([]);
  });

  test("returns no parts for a result that isn't the recognized shape", () => {
    expect(
      artifactPartsForToolCall({
        isError: false,
        result: JSON.stringify({ ok: true }),
      }),
    ).toEqual([]);
  });

  test("never fabricates a part for the old persisted:false shape", () => {
    expect(
      artifactPartsForToolCall({
        isError: false,
        result: JSON.stringify({
          title: "Notes",
          content: "body",
          persisted: false,
          persistedReason: "not reachable yet",
        }),
      }),
    ).toEqual([]);
  });
});

describe("artifactPartsForFinalizedTurn", () => {
  test("flattens parts across every tool call in the turn", () => {
    const parts = artifactPartsForFinalizedTurn([
      {
        isError: false,
        result: JSON.stringify({
          id: "art_1",
          version: 1,
          title: "Notes",
          kind: "text",
          persisted: true,
        }),
      },
      { isError: true, result: "denied by approver" },
    ]);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.artifactId).toBe("art_1");
  });

  test("returns an empty array when no tool call names a persisted artifact", () => {
    expect(
      artifactPartsForFinalizedTurn([{ isError: false, result: "{}" }]),
    ).toEqual([]);
  });
});
