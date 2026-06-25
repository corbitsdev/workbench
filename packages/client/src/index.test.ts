/// <reference types="bun" />
// Contract tests for the framework-agnostic HTTP client. These pin the public
// request construction (URL, method, headers, credentials), response handling,
// and error propagation behavior so a backwards-incompatible change fails loudly.
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import "./test-setup";
import { listArtifacts, listWorkflows } from "./index";

type FetchArgs = [input: string | URL | Request, init?: RequestInit];

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
    const { spy, fetcher } = makeFetch(() => Promise.resolve(jsonResponse([])));

    await listArtifacts({ baseUrl: "http://localhost:4000", fetch: fetcher });

    expect(spy.mock.calls[0]?.[0]).toBe(
      "http://localhost:4000/api/v1/artifacts",
    );
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
    const { spy, fetcher } = makeFetch(() => Promise.resolve(jsonResponse([])));

    await listArtifacts(
      { baseUrl: "http://localhost:4000", fetch: fetcher },
      { tenantId: "tenant-1" },
    );

    expect(spy.mock.calls[0]?.[0]).toBe(
      "http://localhost:4000/api/v1/artifacts?tenantId=tenant-1",
    );
  });

  it("omits the query string when tenantId is null or absent", async () => {
    const { spy, fetcher } = makeFetch(() => Promise.resolve(jsonResponse([])));

    await listArtifacts(
      { baseUrl: "http://localhost:4000", fetch: fetcher },
      { tenantId: null },
    );

    expect(spy.mock.calls[0]?.[0]).toBe(
      "http://localhost:4000/api/v1/artifacts",
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
    const page = { artifacts: [{ id: "a" }], nextCursor: null };
    const globalSpy = mock(() => Promise.resolve(jsonResponse(page)));
    globalThis.fetch = Object.assign(globalSpy, {
      preconnect: mock(() => {}),
    }) as typeof fetch;

    const result: unknown = await listArtifacts({
      baseUrl: "http://localhost:4000",
    });

    expect(globalSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual(page);
  });
});
