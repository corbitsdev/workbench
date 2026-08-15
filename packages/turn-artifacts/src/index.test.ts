import { describe, expect, test } from "bun:test";

import {
  persistedArtifactsForFinalizedTurn,
  persistedArtifactsForToolCall,
} from "./index";

describe("persistedArtifactsForToolCall", () => {
  test("parses a single persisted-artifact result", () => {
    const artifacts = persistedArtifactsForToolCall({
      isError: false,
      result: JSON.stringify({
        id: "art_1",
        title: "Postmortem draft",
        kind: "text",
        persisted: true,
      }),
    });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      id: "art_1",
      title: "Postmortem draft",
      kind: "text",
    });
  });

  test("parses a batched result", () => {
    const artifacts = persistedArtifactsForToolCall({
      isError: false,
      result: JSON.stringify({
        artifacts: [
          { id: "art_1", title: "One", kind: "text", persisted: true },
          { id: "art_2", title: "Two", kind: "binary", persisted: true },
        ],
      }),
    });
    expect(artifacts.map((artifact) => artifact.id)).toEqual([
      "art_1",
      "art_2",
    ]);
  });

  test("an errored call yields nothing", () => {
    expect(
      persistedArtifactsForToolCall({
        isError: true,
        result: JSON.stringify({
          id: "art_1",
          title: "One",
          kind: "text",
          persisted: true,
        }),
      }),
    ).toEqual([]);
  });

  test("unparseable JSON yields nothing", () => {
    expect(
      persistedArtifactsForToolCall({ isError: false, result: "not json" }),
    ).toEqual([]);
  });

  test("an unrecognized shape yields nothing — never a guess", () => {
    expect(
      persistedArtifactsForToolCall({
        isError: false,
        result: JSON.stringify({ status: "ok" }),
      }),
    ).toEqual([]);
  });
});

describe("persistedArtifactsForFinalizedTurn", () => {
  test("flattens artifacts across every recognized call", () => {
    const artifacts = persistedArtifactsForFinalizedTurn([
      { isError: false, result: JSON.stringify({ status: "ok" }) },
      {
        isError: false,
        result: JSON.stringify({
          id: "art_1",
          title: "One",
          kind: "text",
          persisted: true,
        }),
      },
      {
        isError: false,
        result: JSON.stringify({
          artifacts: [
            { id: "art_2", title: "Two", kind: "text", persisted: true },
          ],
        }),
      },
    ]);
    expect(artifacts.map((artifact) => artifact.id)).toEqual([
      "art_1",
      "art_2",
    ]);
  });
});
