import { describe, expect, test } from "bun:test";
import {
  scoutArtifactTools,
  SCOUT_ARTIFACT_SAVE_TOOL,
  SCOUT_ARTIFACT_LIST_TOOL,
  type ScoutArtifactEnv,
} from "./artifact-tool";

function testEnv(): ScoutArtifactEnv {
  return {
    hubArtifactsUrl: "https://hub.example",
    sidecarToken: "token",
    address: "run@example",
  } as unknown as ScoutArtifactEnv;
}

async function withMockFetch<T>(
  response: () => Response,
  run: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => response()) as unknown as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("scoutArtifactTools", () => {
  test("declares the save tool with approval: ask", () => {
    const saveDef = scoutArtifactTools.definitions.find(
      (d) => d.name === SCOUT_ARTIFACT_SAVE_TOOL,
    );
    expect(saveDef?.approval).toBe("ask");
  });

  test("scout_save_artifact persists content and reports the artifact id", async () => {
    const result = await withMockFetch(
      () =>
        new Response(JSON.stringify({ data: { id: "art_9", version: 1 } }), {
          status: 201,
        }),
      () => {
        const bundle = scoutArtifactTools(testEnv());
        return bundle.run(
          {
            id: "call_1",
            name: SCOUT_ARTIFACT_SAVE_TOOL,
            arguments: { title: "Findings", content: "Full text" },
          },
          new AbortController().signal,
        );
      },
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(String(result.content))).toEqual({
      id: "art_9",
      version: 1,
      title: "Findings",
      persisted: true,
    });
  });

  test("scout_save_artifact reports a failure honestly rather than fabricating success", async () => {
    const result = await withMockFetch(
      () => new Response("nope", { status: 500 }),
      () => {
        const bundle = scoutArtifactTools(testEnv());
        return bundle.run(
          {
            id: "call_2",
            name: SCOUT_ARTIFACT_SAVE_TOOL,
            arguments: { title: "Findings", content: "Full text" },
          },
          new AbortController().signal,
        );
      },
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("Failed to persist");
  });

  test("scout_list_recent_artifacts returns the recent items", async () => {
    const result = await withMockFetch(
      () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "art_1",
                title: "Note",
                kind: "text",
                createdAt: "2026-08-01T00:00:00Z",
              },
            ],
          }),
          { status: 200 },
        ),
      () => {
        const bundle = scoutArtifactTools(testEnv());
        return bundle.run(
          { id: "call_3", name: SCOUT_ARTIFACT_LIST_TOOL, arguments: {} },
          new AbortController().signal,
        );
      },
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(String(result.content)).items).toHaveLength(1);
  });
});
