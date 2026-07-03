/// <reference types="bun" />
// Contract tests for the framework-agnostic HTTP client. These pin the public
// request construction (URL, method, headers, credentials), response handling,
// and error propagation behavior so a backwards-incompatible change fails loudly.
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import "./test-setup";
import {
  createArtifact,
  getActor,
  listArtifacts,
  listWorkflows,
  uploadArtifacts,
  type Actor,
} from "./index";

type FetchArgs = [input: string | URL | Request, init?: RequestInit];

// A well-formed empty `GET /artifacts` page. listArtifacts now validates its
// response, so URL-construction tests must return a parseable page body.
const emptyArtifactsPage = { artifacts: [], nextCursor: null };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Build a fetch double that satisfies `typeof fetch` (it carries `preconnect`). */
function makeFetch(impl: (...args: FetchArgs) => Promise<Response>) {
  const spy = mock(impl);
  const fetcher = Object.assign(
    (input: FetchArgs[0], init?: FetchArgs[1]) => spy(input, init),
    {
      preconnect: mock(() => {}),
    },
  ) as unknown as typeof fetch;
  return { spy, fetcher };
}

describe("@workbench/client request construction", () => {
  it("builds the workflow-runs URL under the api/v1 prefix against the provided baseUrl", async () => {
    const { spy, fetcher } = makeFetch(() => Promise.resolve(jsonResponse([])));

    await listWorkflows({ baseUrl: "http://localhost:4000", fetch: fetcher });

    expect(spy.mock.calls[0]?.[0]).toBe(
      "http://localhost:4000/api/v1/workflow-runs",
    );
  });

  it("builds the artifacts URL under the api/v1 prefix against the provided baseUrl", async () => {
    const { spy, fetcher } = makeFetch(() =>
      Promise.resolve(jsonResponse(emptyArtifactsPage)),
    );

    await listArtifacts({ baseUrl: "http://localhost:4000", fetch: fetcher });

    expect(spy.mock.calls[0]?.[0]).toBe(
      "http://localhost:4000/api/v1/artifacts",
    );
  });

  it("POSTs a create-artifact body and returns the parsed artifact", async () => {
    const responseArtifact = {
      id: "art-9",
      parentId: null,
      kind: "link",
      title: "Docs",
      content: "https://example.com",
      status: "draft",
      version: 1,
      ownerPrincipalId: "prn-1",
      createdAt: "2026-06-26T00:00:00.000Z",
      updatedAt: "2026-06-26T00:00:00.000Z",
      source: { origin: "imported", url: "https://example.com" },
    };
    const { spy, fetcher } = makeFetch(() =>
      Promise.resolve(jsonResponse({ artifact: responseArtifact }, 201)),
    );

    const result = await createArtifact(
      { baseUrl: "http://localhost:4000", fetch: fetcher },
      { mode: "url", title: "Docs", content: "https://example.com" },
    );

    expect(spy.mock.calls[0]?.[0]).toBe(
      "http://localhost:4000/api/v1/artifacts",
    );
    expect(spy.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(spy.mock.calls[0]?.[1]?.body))).toEqual({
      mode: "url",
      title: "Docs",
      content: "https://example.com",
    });
    expect(result.id).toBe("art-9");
    expect(result.source?.origin).toBe("imported");
  });

  it("throws when the create-artifact response is malformed", async () => {
    const { fetcher } = makeFetch(() =>
      Promise.resolve(jsonResponse({ artifact: { id: 42 } }, 201)),
    );
    await expect(
      createArtifact(
        { baseUrl: "http://localhost:4000", fetch: fetcher },
        { mode: "text", title: "T", content: "C" },
      ),
    ).rejects.toThrow("Invalid POST /artifacts response");
  });

  it("uploads files as multipart/form-data and returns the parsed artifacts", async () => {
    const responseArtifact = {
      id: "art-up",
      parentId: null,
      kind: "file",
      title: "notes.txt",
      content: "upl-1",
      status: "draft",
      version: 1,
      ownerPrincipalId: "prn-1",
      createdAt: "2026-06-26T00:00:00.000Z",
      updatedAt: "2026-06-26T00:00:00.000Z",
      source: { origin: "imported" },
    };
    const { spy, fetcher } = makeFetch(() =>
      Promise.resolve(jsonResponse({ artifacts: [responseArtifact] }, 201)),
    );

    const file = new File([new Uint8Array(3)], "notes.txt", {
      type: "text/plain",
    });
    const result = await uploadArtifacts(
      { baseUrl: "http://localhost:4000", fetch: fetcher },
      { tenantId: "tn-1", files: [file] },
    );

    expect(spy.mock.calls[0]?.[0]).toBe(
      "http://localhost:4000/api/v1/artifacts/upload?tenantId=tn-1",
    );
    expect(spy.mock.calls[0]?.[1]?.method).toBe("POST");
    const sentBody = spy.mock.calls[0]?.[1]?.body;
    expect(sentBody).toBeInstanceOf(FormData);
    expect((sentBody as FormData).getAll("files")).toHaveLength(1);
    expect(result[0]?.id).toBe("art-up");
    expect(result[0]?.source?.origin).toBe("imported");
  });

  it("throws when the upload response is malformed", async () => {
    const { fetcher } = makeFetch(() =>
      Promise.resolve(jsonResponse({ artifacts: [{ id: 7 }] }, 201)),
    );
    const file = new File([new Uint8Array(1)], "x.txt", { type: "text/plain" });
    await expect(
      uploadArtifacts(
        { baseUrl: "http://localhost:4000", fetch: fetcher },
        { files: [file] },
      ),
    ).rejects.toThrow("Invalid POST /artifacts/upload response");
  });

  it("issues a GET with credentials included by default", async () => {
    const { spy, fetcher } = makeFetch(() => Promise.resolve(jsonResponse([])));

    await listWorkflows({ baseUrl: "http://localhost:4000", fetch: fetcher });

    const init = spy.mock.calls[0]?.[1];
    expect(init?.method).toBe("GET");
    expect(init?.credentials).toBe("include");
  });

  it("merges caller-provided init (headers, signal) over the defaults", async () => {
    const { spy, fetcher } = makeFetch(() => Promise.resolve(jsonResponse([])));
    const controller = new AbortController();

    await listWorkflows({
      baseUrl: "http://localhost:4000",
      fetch: fetcher,
      init: {
        headers: { authorization: "Bearer t" },
        signal: controller.signal,
      },
    });

    const init = spy.mock.calls[0]?.[1];
    expect(init?.method).toBe("GET");
    expect(init?.credentials).toBe("include");
    expect(init?.headers).toEqual({ authorization: "Bearer t" });
    expect(init?.signal).toBe(controller.signal);
  });

  it("lets caller init override the default method and credentials", async () => {
    const { spy, fetcher } = makeFetch(() => Promise.resolve(jsonResponse([])));

    await listWorkflows({
      baseUrl: "http://localhost:4000",
      fetch: fetcher,
      init: { method: "POST", credentials: "omit" },
    });

    const init = spy.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("omit");
  });

  it("forwards tenantId on the query string, url-encoded, so the active workbench is visible", async () => {
    const { spy, fetcher } = makeFetch(() => Promise.resolve(jsonResponse([])));

    await listWorkflows(
      { baseUrl: "http://localhost:4000", fetch: fetcher },
      { tenantId: "tenant/with space" },
    );

    expect(spy.mock.calls[0]?.[0]).toBe(
      "http://localhost:4000/api/v1/workflow-runs?tenantId=tenant%2Fwith%20space",
    );
  });

  it("appends a url-encoded tenantId query param for artifacts", async () => {
    const { spy, fetcher } = makeFetch(() =>
      Promise.resolve(jsonResponse(emptyArtifactsPage)),
    );

    await listArtifacts(
      { baseUrl: "http://localhost:4000", fetch: fetcher },
      { tenantId: "tenant-1" },
    );

    expect(spy.mock.calls[0]?.[0]).toBe(
      "http://localhost:4000/api/v1/artifacts?tenantId=tenant-1",
    );
  });

  it("omits the query string when tenantId is null or absent", async () => {
    const { spy, fetcher } = makeFetch(() =>
      Promise.resolve(jsonResponse(emptyArtifactsPage)),
    );

    await listArtifacts(
      { baseUrl: "http://localhost:4000", fetch: fetcher },
      { tenantId: null },
    );

    expect(spy.mock.calls[0]?.[0]).toBe(
      "http://localhost:4000/api/v1/artifacts",
    );
  });

  it("forwards the creatorKind filter on the query string", async () => {
    const { spy, fetcher } = makeFetch(() =>
      Promise.resolve(jsonResponse(emptyArtifactsPage)),
    );

    await listArtifacts(
      { baseUrl: "http://localhost:4000", fetch: fetcher },
      { creatorKind: "agent" },
    );

    expect(spy.mock.calls[0]?.[0]).toBe(
      "http://localhost:4000/api/v1/artifacts?creatorKind=agent",
    );
  });
});

describe("@workbench/client baseUrl resolution", () => {
  const originalLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );

  afterEach(() => {
    if (originalLocation) {
      Object.defineProperty(globalThis, "location", originalLocation);
    }
  });

  // The test-setup preload registers happy-dom with a fixed document origin, so
  // `globalThis.location` is present. This pins the same-origin fallback: when
  // no baseUrl is supplied, requests resolve against the global location origin.
  it("falls back to the global location origin when no baseUrl is provided", async () => {
    const { spy, fetcher } = makeFetch(() => Promise.resolve(jsonResponse([])));

    await listWorkflows({ fetch: fetcher });

    expect(spy.mock.calls[0]?.[0]).toBe(
      `${globalThis.location.origin}/api/v1/workflow-runs`,
    );
  });

  it("throws a descriptive error when there is no baseUrl and no global location", async () => {
    // Simulate a non-browser runtime by overriding the location getter.
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      get: () => undefined,
    });
    const { fetcher } = makeFetch(() => Promise.resolve(jsonResponse([])));

    await expect(listWorkflows({ fetch: fetcher })).rejects.toThrow(
      /Cannot resolve request URL/,
    );
  });
});

describe("@workbench/client response and error handling", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("maps each /workflow-runs row, exposing deploymentId as id", async () => {
    const payload = [
      {
        deploymentId: "dep-1",
        kind: "presentation-generation",
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const { fetcher } = makeFetch(() => Promise.resolve(jsonResponse(payload)));

    const result = await listWorkflows({
      baseUrl: "http://localhost:4000",
      fetch: fetcher,
    });

    expect(result).toEqual([
      {
        id: "dep-1",
        kind: "presentation-generation",
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("throws when the /workflow-runs response fails schema validation", async () => {
    const { fetcher } = makeFetch(() =>
      Promise.resolve(jsonResponse([{ deploymentId: "dep-1" }])),
    );

    await expect(
      listWorkflows({ baseUrl: "http://localhost:4000", fetch: fetcher }),
    ).rejects.toThrow(/Invalid \/workflow-runs response/);
  });

  it("resolves a single actor under the tenant api prefix and parses it", async () => {
    const actor: Actor = {
      id: "prn_u1",
      kind: "user",
      displayName: "Myra Ops",
      email: "myra@example.com",
      status: "active",
    };
    const { spy, fetcher } = makeFetch(() =>
      Promise.resolve(jsonResponse(actor)),
    );

    const result = await getActor(
      { baseUrl: "http://localhost:4000", fetch: fetcher },
      { tenantId: "tn-1", principalId: "prn_u1" },
    );

    expect(spy.mock.calls[0]?.[0]).toBe(
      "http://localhost:4000/api/tenants/tn-1/actors/prn_u1",
    );
    expect(result).toEqual(actor);
  });

  it("returns null when the actor lookup 404s", async () => {
    const { fetcher } = makeFetch(() =>
      Promise.resolve(jsonResponse({ error: "not found" }, 404)),
    );

    const result = await getActor(
      { baseUrl: "http://localhost:4000", fetch: fetcher },
      { tenantId: "tn-1", principalId: "prn_missing" },
    );

    expect(result).toBeNull();
  });

  it("surfaces the hub's object-shaped error message on a non-404 actor failure", async () => {
    // The hub returns `{ error: { code, message } }`; getActor must read
    // `.message`, not stringify the object into `[object Object]`.
    const { fetcher } = makeFetch(() =>
      Promise.resolve(
        jsonResponse(
          { error: { code: "internal_error", message: "Actor lookup failed" } },
          500,
        ),
      ),
    );

    await expect(
      getActor(
        { baseUrl: "http://localhost:4000", fetch: fetcher },
        { tenantId: "tn-1", principalId: "prn_u1" },
      ),
    ).rejects.toThrow("Actor lookup failed");
  });

  it("falls back to an HTTP status when the actor error body has no message", async () => {
    const { fetcher } = makeFetch(() =>
      Promise.resolve(jsonResponse({ error: { code: "boom" } }, 500)),
    );

    await expect(
      getActor(
        { baseUrl: "http://localhost:4000", fetch: fetcher },
        { tenantId: "tn-1", principalId: "prn_u1" },
      ),
    ).rejects.toThrow("HTTP 500");
  });

  it("throws when the actor response fails schema validation", async () => {
    const { fetcher } = makeFetch(() =>
      Promise.resolve(jsonResponse({ id: "prn_u1" })),
    );

    await expect(
      getActor(
        { baseUrl: "http://localhost:4000", fetch: fetcher },
        { tenantId: "tn-1", principalId: "prn_u1" },
      ),
    ).rejects.toThrow(/Invalid \/actors\/:id response/);
  });

  it("throws the server-supplied error message on a non-ok response", async () => {
    const { fetcher } = makeFetch(() =>
      Promise.resolve(jsonResponse({ error: "forbidden tenant" }, 403)),
    );

    await expect(
      listArtifacts({ baseUrl: "http://localhost:4000", fetch: fetcher }),
    ).rejects.toThrow("forbidden tenant");
  });

  it("falls back to an HTTP status message when the error body is not JSON", async () => {
    const { fetcher } = makeFetch(() =>
      Promise.resolve(new Response("<html>nope</html>", { status: 500 })),
    );

    await expect(
      listWorkflows({ baseUrl: "http://localhost:4000", fetch: fetcher }),
    ).rejects.toThrow("HTTP 500");
  });

  it("falls back to an HTTP status message when an ok-less body lacks an error field", async () => {
    const { fetcher } = makeFetch(() =>
      Promise.resolve(jsonResponse({ detail: "x" }, 404)),
    );

    await expect(
      listWorkflows({ baseUrl: "http://localhost:4000", fetch: fetcher }),
    ).rejects.toThrow("HTTP 404");
  });

  it("uses the global fetch when no custom fetch is supplied", async () => {
    const page = {
      artifacts: [
        {
          id: "a",
          parentId: null,
          kind: "link",
          title: "T",
          content: "C",
          status: "draft",
          version: 1,
          ownerPrincipalId: "prn-1",
          createdAt: "2026-06-26T00:00:00.000Z",
          updatedAt: "2026-06-26T00:00:00.000Z",
          source: { origin: "imported" },
          sessionName: null,
          sessionStatus: "done",
          ownerName: null,
        },
      ],
      nextCursor: null,
    };
    const globalSpy = mock(() => Promise.resolve(jsonResponse(page)));
    globalThis.fetch = Object.assign(globalSpy, {
      preconnect: mock(() => {}),
    }) as typeof fetch;

    const result = await listArtifacts({
      baseUrl: "http://localhost:4000",
    });

    expect(globalSpy).toHaveBeenCalledTimes(1);
    expect(result.artifacts[0]?.id).toBe("a");
    expect(result.nextCursor).toBeNull();
  });

  it("throws when the /artifacts page fails schema validation", async () => {
    const { fetcher } = makeFetch(() =>
      Promise.resolve(
        jsonResponse({ artifacts: [{ id: "a" }], nextCursor: null }),
      ),
    );

    await expect(
      listArtifacts({ baseUrl: "http://localhost:4000", fetch: fetcher }),
    ).rejects.toThrow(/Invalid \/artifacts response/);
  });
});
