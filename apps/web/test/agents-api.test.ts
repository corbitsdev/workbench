// The Agents page directory client: model catalog path/shape and failure
// isolation so a broken picker never blanks definitions and instances.

import { afterEach, describe, expect, test } from "bun:test";

import {
  listCatalogModels,
  loadAgentDirectory,
} from "../src/agents-api";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type RecordedCall = { readonly path: string };

function stubFetch(respond: (path: string) => Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path =
      typeof input === "string" ? input : new URL(String(input)).pathname;
    const full =
      typeof input === "string"
        ? input
        : `${new URL(String(input)).pathname}${new URL(String(input)).search}`;
    calls.push({ path: typeof input === "string" ? input : full });
    // Matchers key on the path-with-query the client builds.
    return Promise.resolve(respond(typeof input === "string" ? input : full));
  }) as typeof fetch;
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const modelFixture = {
  id: "mdl_1",
  tenantId: "tnt_1",
  canonicalName: "anthropic/claude-sonnet-4",
  displayName: "Claude Sonnet 4",
  description: null,
  disabled: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const disabledModel = {
  ...modelFixture,
  id: "mdl_2",
  canonicalName: "disabled/model",
  disabled: true,
};

const definitionFixture = {
  id: "wfd_1",
  tenantId: "tnt_1",
  name: "Researcher",
  description: "Answers research questions",
  currentVersion: "1",
  status: "deployed" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const instanceFixture = {
  id: "ins_1",
  definitionId: "wfd_1",
  definitionName: "Researcher",
  tenantId: "tnt_1",
  address: "ins_1@acme.localhost",
  status: "running" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("listCatalogModels", () => {
  test("fetches the paginated catalog models endpoint", async () => {
    const calls = stubFetch((path) => {
      expect(path.startsWith("/api/tenants/tnt_1/catalog/models")).toBe(true);
      return json({ data: [modelFixture, disabledModel], nextCursor: null });
    });

    const models = await listCatalogModels("tnt_1");
    expect(calls[0]?.path).toContain("/api/tenants/tnt_1/catalog/models");
    expect(models).toEqual([modelFixture]);
  });

  test("rejects the bare-array discovery shape the wrong endpoint returns", async () => {
    stubFetch(() =>
      json([
        {
          id: "mdl_1",
          canonicalName: "anthropic/claude-sonnet-4",
          offerings: [],
        },
      ]),
    );

    await expect(listCatalogModels("tnt_1")).rejects.toThrow(
      /Unexpected response shape/,
    );
  });
});

describe("loadAgentDirectory", () => {
  test("loads definitions and instances even when the model catalog fails", async () => {
    stubFetch((path) => {
      if (path.includes("/workflows/definitions")) {
        return json({ data: [definitionFixture], nextCursor: null });
      }
      if (path.includes("/workflows/runs")) {
        return json({ data: [instanceFixture], nextCursor: null });
      }
      if (path.includes("/catalog/models")) {
        return json({ error: { message: "catalog down" } }, 503);
      }
      return json({ error: { message: "unexpected" } }, 500);
    });

    const directory = await loadAgentDirectory("tnt_1");
    expect(directory.definitions).toEqual([definitionFixture]);
    expect(directory.instances).toEqual([instanceFixture]);
    expect(directory.models).toEqual([]);
    expect(directory.modelsError).toMatch(/503|catalog/i);
  });

  test("surfaces a definitions failure as a hard error", async () => {
    stubFetch((path) => {
      if (path.includes("/workflows/definitions")) {
        return json({ error: { message: "nope" } }, 500);
      }
      if (path.includes("/workflows/runs")) {
        return json({ data: [instanceFixture], nextCursor: null });
      }
      if (path.includes("/catalog/models")) {
        return json({ data: [modelFixture], nextCursor: null });
      }
      return json({ error: { message: "unexpected" } }, 500);
    });

    await expect(loadAgentDirectory("tnt_1")).rejects.toThrow(/500/);
  });

  test("returns ready models when the catalog succeeds", async () => {
    stubFetch((path) => {
      if (path.includes("/workflows/definitions")) {
        return json({ data: [definitionFixture], nextCursor: null });
      }
      if (path.includes("/workflows/runs")) {
        return json({ data: [instanceFixture], nextCursor: null });
      }
      if (path.includes("/catalog/models")) {
        return json({ data: [modelFixture], nextCursor: null });
      }
      return json({ error: { message: "unexpected" } }, 500);
    });

    const directory = await loadAgentDirectory("tnt_1");
    expect(directory.models).toEqual([modelFixture]);
    expect(directory.modelsError).toBeUndefined();
  });
});
