import { describe, expect, test } from "bun:test";
import {
  createScoutArtifact,
  listRecentScoutArtifacts,
} from "./artifact-client";

const CONFIG = {
  hubArtifactsUrl: "https://hub.example",
  sidecarToken: "sidecar-token",
  runAddress: "run@example",
};

describe("createScoutArtifact", () => {
  test("posts the input and returns the persisted id/version", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(
        JSON.stringify({ data: { id: "art_1", version: 1 } }),
        {
          status: 201,
        },
      );
    }) as unknown as typeof fetch;

    const result = await createScoutArtifact(
      { ...CONFIG, fetchImpl },
      { title: "Diligence note", kind: "text", content: "Body" },
    );

    expect(result).toEqual({ id: "art_1", version: 1 });
    expect(capturedUrl).toBe("https://hub.example/api/workflow-artifacts/");
    expect(capturedInit?.method).toBe("POST");
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      title: "Diligence note",
      kind: "text",
      content: "Body",
    });
  });

  test("throws on a failed response", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;

    await expect(
      createScoutArtifact(
        { ...CONFIG, fetchImpl },
        { title: "x", kind: "text", content: "y" },
      ),
    ).rejects.toThrow(/Scout artifact create failed/);
  });
});

describe("listRecentScoutArtifacts", () => {
  test("returns the recent list", async () => {
    const fetchImpl = (async () =>
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
      )) as unknown as typeof fetch;

    const items = await listRecentScoutArtifacts({ ...CONFIG, fetchImpl });
    expect(items).toEqual([
      {
        id: "art_1",
        title: "Note",
        kind: "text",
        createdAt: "2026-08-01T00:00:00Z",
      },
    ]);
  });

  test("throws on a shape mismatch", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: "not an array" }), {
        status: 200,
      })) as unknown as typeof fetch;

    await expect(
      listRecentScoutArtifacts({ ...CONFIG, fetchImpl }),
    ).rejects.toThrow(/did not match the expected shape/);
  });
});
