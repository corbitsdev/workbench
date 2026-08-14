import { expect, test } from "bun:test";

import { createWorkflowArtifact } from "./artifact-client";

const CONFIG = {
  hubArtifactsUrl: "https://hub.example.com",
  sidecarToken: "sc-token",
  runAddress: "run_1@workflow",
};

test("posts to the workflow-artifacts endpoint and returns id/version", async () => {
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
});

test("throws on a non-ok HTTP response", async () => {
  const fetchImpl = (async () =>
    new Response("nope", { status: 500 })) as unknown as typeof fetch;

  await expect(
    createWorkflowArtifact(
      { ...CONFIG, fetchImpl },
      { title: "Notes", kind: "text", content: "hello" },
    ),
  ).rejects.toThrow(/500/);
});

test("throws when the response doesn't match the expected shape", async () => {
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
