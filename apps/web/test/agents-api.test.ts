// The Agents page directory client: model catalog path/shape and failure
// isolation so a broken picker never blanks definitions and instances.

import { afterEach, describe, expect, test } from "bun:test";

import {
  listCatalogModels,
  loadAgentDirectory,
  updateAgentSkills,
} from "../src/agents-api";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type RecordedCall = { readonly path: string; readonly method: string };

function stubFetch(respond: (path: string) => Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const full =
      typeof input === "string"
        ? input
        : `${new URL(String(input)).pathname}${new URL(String(input)).search}`;
    const path = typeof input === "string" ? input : full;
    calls.push({ path, method: init?.method ?? "GET" });
    // Matchers key on the path-with-query the client builds.
    return Promise.resolve(respond(path));
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
      if (path.includes("/chat/channels")) {
        return json({ items: [] });
      }
      return json({ error: { message: "unexpected" } }, 500);
    });

    const directory = await loadAgentDirectory("tnt_1");
    expect(directory.definitions).toEqual([definitionFixture]);
    expect(directory.instances).toEqual([instanceFixture]);
    expect(directory.models).toEqual([]);
    expect(directory.modelsError).toMatch(/503|catalog/i);
    expect(directory.foldedRunIds.size).toBe(0);
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
      if (path.includes("/chat/channels")) {
        return json({ items: [] });
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
      if (path.includes("/chat/channels")) {
        return json({ items: [] });
      }
      return json({ error: { message: "unexpected" } }, 500);
    });

    const directory = await loadAgentDirectory("tnt_1");
    expect(directory.models).toEqual([modelFixture]);
    expect(directory.modelsError).toBeUndefined();
  });

  test("carries each definition's attached skills", async () => {
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
      if (path.includes("/agent-definitions/skills")) {
        return json({ skills: { wfd_1: ["web-research"] } });
      }
      if (path.includes("/chat/channels")) {
        return json({ items: [] });
      }
      return json({ error: { message: "unexpected" } }, 500);
    });

    const directory = await loadAgentDirectory("tnt_1");
    expect(directory.definitionSkills).toEqual({ wfd_1: ["web-research"] });
  });

  test("a broken skills endpoint degrades to no attachments rather than blanking the page", async () => {
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
      if (path.includes("/agent-definitions/skills")) {
        return json({ error: { message: "down" } }, 500);
      }
      if (path.includes("/chat/channels")) {
        return json({ items: [] });
      }
      return json({ error: { message: "unexpected" } }, 500);
    });

    const directory = await loadAgentDirectory("tnt_1");
    expect(directory.definitionSkills).toEqual({});
  });

  test("collects the folded-run-id set from every channel's host id and participant addresses", async () => {
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
      if (path.includes("/chat/channels")) {
        expect(path).toBe("/api/tenants/tnt_1/chat/channels");
        return json({
          items: [
            {
              id: "chan_host1",
              title: "General",
              kind: "channel",
              pinned: false,
              participants: [
                { address: "ins_invited1@tnt1.workbench.test", handle: "echo" },
              ],
            },
          ],
        });
      }
      return json({ error: { message: "unexpected" } }, 500);
    });

    const directory = await loadAgentDirectory("tnt_1");
    expect(directory.foldedRunIds.has("chan_host1")).toBe(true);
    expect(directory.foldedRunIds.has("ins_invited1")).toBe(true);
  });

  test("a 404 from the channels route (chat not mounted) degrades to an empty folded-run-id set", async () => {
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
      if (path.includes("/chat/channels")) {
        return json({ error: { message: "not found" } }, 404);
      }
      return json({ error: { message: "unexpected" } }, 500);
    });

    // A chat-less host has no folded chat runs to filter, so an empty
    // set is the correct answer — the page must still load.
    const directory = await loadAgentDirectory("tnt_1");
    expect(directory.foldedRunIds.size).toBe(0);
    expect(directory.instances).toEqual([instanceFixture]);
  });

  test("fails the whole load when the channels fetch fails, rather than silently dropping the filter", async () => {
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
      if (path.includes("/chat/channels")) {
        return json({ error: { message: "chat down" } }, 500);
      }
      return json({ error: { message: "unexpected" } }, 500);
    });

    await expect(loadAgentDirectory("tnt_1")).rejects.toThrow();
  });
});

describe("updateAgentSkills", () => {
  test("PUTs the full replacement skill set and returns it back", async () => {
    const calls = stubFetch((path) => {
      expect(path).toBe("/api/tenants/tnt_1/agent-definitions/wfd_1/skills");
      return json({ skills: ["web-research"] });
    });

    const skills = await updateAgentSkills("tnt_1", "wfd_1", ["web-research"]);
    expect(calls.length).toBe(1);
    expect(calls[0]?.method).toBe("PUT");
    expect(skills).toEqual(["web-research"]);
  });
});
