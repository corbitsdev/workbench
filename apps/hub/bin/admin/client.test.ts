import { describe, it, expect, mock, afterEach } from "bun:test";

// A minimal OpenAPI 3.1 spec the vendored createClient can parse, served via a
// stubbed fetch so the client never touches the network.
const FIXTURE_SPEC = {
  openapi: "3.1.0",
  info: { title: "Test Hub", version: "1.0.0" },
  paths: {
    "/api/v1/things": {
      get: {
        operationId: "listThings",
        summary: "List things",
        tags: ["Things"],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { count: { type: "integer" } },
                  required: ["count"],
                },
              },
            },
          },
        },
      },
    },
    "/api/v1/things/{id}": {
      delete: {
        operationId: "deleteThing",
        summary: "Delete a thing",
        tags: ["Things"],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: { "204": { description: "deleted" } },
      },
    },
  },
};

afterEach(() => {
  mock.restore();
});

async function makeClient() {
  globalThis.fetch = mock(async (url: string) => {
    if (String(url).endsWith("/openapi.json")) {
      return new Response(JSON.stringify(FIXTURE_SPEC), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;

  const { createHubClient } = await import("./client");
  return createHubClient({ baseUrl: "https://hub.example.com", cookies: [] });
}

describe("createHubClient", () => {
  it("discovers operations from the spec, sorted by tag/path", async () => {
    const client = await makeClient();
    const ops = client.operations();

    expect(ops).toEqual([
      {
        tag: "Things",
        method: "get",
        path: "/api/v1/things",
        operationId: "listThings",
        summary: "List things",
      },
      {
        tag: "Things",
        method: "delete",
        path: "/api/v1/things/{id}",
        operationId: "deleteThing",
        summary: "Delete a thing",
      },
    ]);
  });

  it("substitutes path params and query into the request URL", async () => {
    const client = await makeClient();

    let calledPath = "";
    globalThis.fetch = mock(async (url: string) => {
      calledPath = String(url);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const res = await client.call("delete", "/api/v1/things/{id}", {
      pathParams: { id: "thing 1" },
      query: { tenant: "gtm", skip: undefined },
    });

    expect(res.status).toBe(204);
    expect(calledPath).toBe(
      "https://hub.example.com/api/v1/things/thing%201?tenant=gtm",
    );
  });

  it("validates a JSON response against the spec schema", async () => {
    const client = await makeClient();

    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ count: 3 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    const res = await client.call("get", "/api/v1/things");
    expect(res.status).toBe(200);
    expect(res.valid).toBe(true);
  });

  it("flags a JSON response that violates the spec schema", async () => {
    const client = await makeClient();

    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ count: "not a number" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    const res = await client.call("get", "/api/v1/things");
    expect(res.valid).toBe(false);
  });
});
