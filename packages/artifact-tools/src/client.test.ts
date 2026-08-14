import { expect, test } from "bun:test";

import {
  createWorkflowArtifact,
  listRecentWorkflowArtifacts,
} from "./client";

const CONFIG = {
  hubArtifactsUrl: "https://hub.example.com",
  sidecarToken: "sc-token",
  runAddress: "run_1@workflow",
};

test("createWorkflowArtifact posts to the workflow-artifacts endpoint and returns id/version", async () => {
  const captured: { url: string; init: RequestInit | undefined } = {
    url: "",
    init: undefined,
  };
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    captured.url = String(input);
    captured.init = init;
    return new Response(JSON.stringify({ data: { id: "art_1", version: 1 } }), {
      status: 201,
    });
  }) as unknown as typeof fetch;

  const result = await createWorkflowArtifact(
    { ...CONFIG, fetchImpl },
    { title: "Notes", kind: "text", content: "hello" },
  );

  expect(result).toEqual({ id: "art_1", version: 1 });
  expect(captured.url).toBe(
    "https://hub.example.com/api/workflow-artifacts/",
  );
  const headers = captured.init?.headers as Record<string, string>;
  expect(headers["authorization"]).toBe("Bearer sc-token");
  expect(headers["x-workflow-run-address"]).toBe("run_1@workflow");
  expect(JSON.parse(String(captured.init?.body))).toEqual({
    title: "Notes",
    kind: "text",
    content: "hello",
  });
});

test("createWorkflowArtifact throws on a non-ok HTTP response", async () => {
  const fetchImpl = (async () =>
    new Response("nope", { status: 401 })) as unknown as typeof fetch;

  await expect(
    createWorkflowArtifact(
      { ...CONFIG, fetchImpl },
      { title: "Notes", kind: "text", content: "hello" },
    ),
  ).rejects.toThrow(/401/);
});

test("createWorkflowArtifact throws when the response doesn't match the expected shape", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ data: {} }), {
      status: 201,
    })) as unknown as typeof fetch;

  await expect(
    createWorkflowArtifact(
      { ...CONFIG, fetchImpl },
      { title: "Notes", kind: "text", content: "hello" },
    ),
  ).rejects.toThrow(/did not match the expected shape/);
});

test("listRecentWorkflowArtifacts GETs the recent endpoint with the limit query param", async () => {
  const captured: { url: string } = { url: "" };
  const fetchImpl = (async (input: URL | string) => {
    captured.url = String(input);
    return new Response(
      JSON.stringify({
        data: [
          {
            id: "art_1",
            kind: "text",
            title: "Notes",
            createdAt: "2026-08-13T00:00:00.000Z",
          },
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const result = await listRecentWorkflowArtifacts(
    { ...CONFIG, fetchImpl },
    { limit: 5 },
  );

  expect(result).toEqual([
    {
      id: "art_1",
      kind: "text",
      title: "Notes",
      createdAt: "2026-08-13T00:00:00.000Z",
    },
  ]);
  expect(captured.url).toBe(
    "https://hub.example.com/api/workflow-artifacts/recent?limit=5",
  );
});

test("listRecentWorkflowArtifacts omits the query param when no limit is given", async () => {
  const captured: { url: string } = { url: "" };
  const fetchImpl = (async (input: URL | string) => {
    captured.url = String(input);
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  await listRecentWorkflowArtifacts({ ...CONFIG, fetchImpl });

  expect(captured.url).toBe(
    "https://hub.example.com/api/workflow-artifacts/recent",
  );
});

test("listRecentWorkflowArtifacts throws on a non-ok HTTP response", async () => {
  const fetchImpl = (async () =>
    new Response("nope", { status: 401 })) as unknown as typeof fetch;

  await expect(
    listRecentWorkflowArtifacts({ ...CONFIG, fetchImpl }),
  ).rejects.toThrow(/401/);
});
