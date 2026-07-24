import { describe, expect, it, mock } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createCaptureTools } from "./capture";
import type { KnowledgeEngineFetch } from "./shared";

type FetchStub = KnowledgeEngineFetch & {
  mock: { calls: [string, RequestInit][] };
};

function makeFetchStub(response: unknown, status = 200): FetchStub {
  return mock((_input: string, _init: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify(response), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

const BASE_CONFIG = {
  apiKey: "svc-token",
  baseURL: "https://engine.example.com",
  tenantId: "tenant_abc",
  principalId: "principal_xyz",
};

describe("createCaptureTools", () => {
  it("returns one tool with the expected definition name", () => {
    const tools = createCaptureTools(BASE_CONFIG);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.definition.name).toBe("capture_to_knowledge");
  });
});

describe("capture_to_knowledge handler", () => {
  it("captures a single `text` field as one chunk with tenant/actor from context", async () => {
    const stubResponse = {
      document_id: "doc_1",
      version_id: "ver_1",
      chunks: 1,
      status: "ingested",
    };
    const fetcher = makeFetchStub(stubResponse);
    const runner = createToolRunner(
      createCaptureTools({ ...BASE_CONFIG, fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "capture_to_knowledge",
        arguments: {
          kind: "call-note",
          title: "Acme renewal call",
          externalRef: "granola:abc123",
          text: "Acme wants to expand seats next quarter.",
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String(result.content))).toEqual({
      documentId: "doc_1",
      versionId: "ver_1",
      chunks: 1,
      status: "ingested",
    });

    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("https://engine.example.com/api/capture");
    const body = JSON.parse(String(call?.[1].body)) as {
      tenant_id: string;
      adapter: string;
      document: {
        kind: string;
        title: string;
        externalRef: string;
        visibility: { mode: string };
        entityHints: { kind: string; identifier: string }[];
        chunks: { ordinal: number; text: string }[];
        actor: { kind: string; principalId?: string };
        contentHash: string;
      };
    };
    expect(body.tenant_id).toBe("tenant_abc");
    expect(body.adapter).toBe("workbench-agent");
    expect(body.document.kind).toBe("call-note");
    expect(body.document.title).toBe("Acme renewal call");
    expect(body.document.externalRef).toBe("granola:abc123");
    expect(body.document.visibility).toEqual({ mode: "tenant" });
    expect(body.document.entityHints).toEqual([]);
    expect(body.document.chunks).toEqual([
      { ordinal: 0, text: "Acme wants to expand seats next quarter." },
    ]);
    expect(body.document.actor).toEqual({
      kind: "agent",
      principalId: "principal_xyz",
    });
    expect(typeof body.document.contentHash).toBe("string");
    expect(body.document.contentHash.length).toBeGreaterThan(0);
  });

  it("preserves chunk order and role when `chunks` is supplied instead of `text`", async () => {
    const fetcher = makeFetchStub({
      document_id: "doc_2",
      version_id: "ver_1",
      chunks: 2,
      status: "ingested",
    });
    const runner = createToolRunner(
      createCaptureTools({ ...BASE_CONFIG, fetcher }),
    );

    await runner.run(
      {
        id: "call_1",
        name: "capture_to_knowledge",
        arguments: {
          kind: "call-note",
          title: "Acme renewal call",
          externalRef: "granola:abc123",
          chunks: [
            { text: "Alice: let's expand seats.", role: "speaker:alice" },
            { text: "Bob: sounds good.", role: "speaker:bob" },
          ],
        },
      },
      new AbortController().signal,
    );

    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1].body)) as {
      document: { chunks: { ordinal: number; text: string; role?: string }[] };
    };
    expect(body.document.chunks).toEqual([
      { ordinal: 0, text: "Alice: let's expand seats.", role: "speaker:alice" },
      { ordinal: 1, text: "Bob: sounds good.", role: "speaker:bob" },
    ]);
  });

  it("sends entityHints, edges, and restricted visibility in the engine's object shapes", async () => {
    const fetcher = makeFetchStub({
      document_id: "doc_3",
      version_id: "ver_1",
      chunks: 1,
      status: "ingested",
    });
    const runner = createToolRunner(
      createCaptureTools({ ...BASE_CONFIG, fetcher }),
    );

    await runner.run(
      {
        id: "call_1",
        name: "capture_to_knowledge",
        arguments: {
          kind: "call-note",
          title: "Acme renewal call",
          externalRef: "granola:abc123",
          text: "Acme wants to expand seats.",
          entityHints: [{ kind: "org", identifier: "acme.com", label: "Acme" }],
          edges: [{ rel: "mentions", to: { type: "entity", ref: "ent_acme" } }],
          visibilityMode: "principals",
          visibilityPrincipalIds: ["principal_xyz"],
          sourceClass: "call",
        },
      },
      new AbortController().signal,
    );

    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1].body)) as {
      document: {
        entityHints: { kind: string; identifier: string; label?: string }[];
        edges: { rel: string; to: { type: string; ref: string } }[];
        visibility: { mode: string; principalIds?: string[] };
        sourceClass: string;
      };
    };
    expect(body.document.entityHints).toEqual([
      { kind: "org", identifier: "acme.com", label: "Acme" },
    ]);
    expect(body.document.edges).toEqual([
      { rel: "mentions", to: { type: "entity", ref: "ent_acme" } },
    ]);
    expect(body.document.visibility).toEqual({
      mode: "principals",
      principalIds: ["principal_xyz"],
    });
    expect(body.document.sourceClass).toBe("call");
  });

  it("rejects a bare-string entityHint locally instead of sending an invalid capture", async () => {
    const fetcher = makeFetchStub({});
    const runner = createToolRunner(
      createCaptureTools({ ...BASE_CONFIG, fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "capture_to_knowledge",
        arguments: {
          kind: "call-note",
          title: "Acme renewal call",
          externalRef: "granola:abc123",
          text: "Acme wants to expand seats.",
          entityHints: ["Acme Corp"],
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("throws when neither `text` nor `chunks` is supplied", async () => {
    const fetcher = makeFetchStub({});
    const runner = createToolRunner(
      createCaptureTools({ ...BASE_CONFIG, fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "capture_to_knowledge",
        arguments: {
          kind: "call-note",
          title: "Acme renewal call",
          externalRef: "granola:abc123",
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("one of `text` or `chunks` is required");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("surfaces API errors", async () => {
    const fetcher = makeFetchStub({ error: "Invalid token" }, 401);
    const runner = createToolRunner(
      createCaptureTools({ ...BASE_CONFIG, fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "capture_to_knowledge",
        arguments: {
          kind: "call-note",
          title: "Acme renewal call",
          externalRef: "granola:abc123",
          text: "Some content",
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Knowledge engine API error: 401");
  });
});
