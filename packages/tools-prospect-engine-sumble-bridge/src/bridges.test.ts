import { afterEach, describe, expect, mock, test } from "bun:test";
import { toolCredentialEnvKey } from "@workbench/tool-credentials";
import { extractOrganizationIds } from "@workbench/shared";

const SUMBLE_ENV = {
  [toolCredentialEnvKey("sumble")]: {
    apiKey: "key",
    baseURL: "https://sumble.example.test",
  },
};

describe("prospectEngineSumbleListBridge", () => {
  afterEach(() => {
    mock.restore();
  });

  test("a thrown/isError underlying tool call degrades to a successful outer envelope, and extractOrganizationIds still falls back to []", async () => {
    mock.module("@workbench/tools-sumble", () => ({
      SUMBLE_HUB_TOOLS: {
        sumble_get_organization_list: {
          createTools: () => [
            {
              kind: "full" as const,
              definition: { name: "sumble_get_organization_list" },
              handler: async () => {
                throw new Error("sumble 500");
              },
            },
          ],
        },
        sumble_add_organization_list_organizations: {
          createTools: () => [],
        },
      },
    }));
    const { prospectEngineSumbleListBridge } = await import("./bridges");
    const runner = prospectEngineSumbleListBridge(SUMBLE_ENV as never);
    const result = await runner.run(
      {
        id: "call1",
        name: "prospect_engine_read_organization_list_tolerant",
        arguments: { listId: 123 },
      },
      new AbortController().signal,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toMatchObject({
      isError: true,
      error: expect.stringContaining("sumble 500"),
    });
    // dedupe/extractListOrgs read the raw content through
    // extractOrganizationIds, which must degrade to [] rather than throwing
    // on the error-envelope shape.
    expect(extractOrganizationIds(result.content)).toEqual([]);
  });

  test("a successful call forwards the underlying tool's organization ids", async () => {
    let forwardedListId: unknown;
    mock.module("@workbench/tools-sumble", () => ({
      SUMBLE_HUB_TOOLS: {
        sumble_get_organization_list: {
          createTools: () => [
            {
              kind: "full" as const,
              definition: { name: "sumble_get_organization_list" },
              handler: async (call: {
                id: string;
                arguments?: Record<string, unknown>;
              }) => {
                forwardedListId = call.arguments?.listId;
                return {
                  callId: call.id,
                  isError: false,
                  content: {
                    organizations: [{ organizationId: 42 }],
                  },
                };
              },
            },
          ],
        },
        sumble_add_organization_list_organizations: { createTools: () => [] },
      },
    }));
    const { prospectEngineSumbleListBridge } = await import("./bridges");
    const runner = prospectEngineSumbleListBridge(SUMBLE_ENV as never);
    const result = await runner.run(
      {
        id: "call1",
        name: "prospect_engine_read_organization_list_tolerant",
        arguments: { listId: 80088 },
      },
      new AbortController().signal,
    );
    expect(result.isError).toBe(false);
    expect(extractOrganizationIds(result.content)).toEqual([42]);
    expect(forwardedListId).toBe(80088);
  });

  // CL-4650: growthList/enterpriseList project intake fields into the
  // object args the harness accepts; the bridge must read those keys and
  // coerce numeric/string ids for sumble_get_organization_list (listId: number).
  test("extracts listId from intake field names and coerces numeric/string ids", async () => {
    const seen: unknown[] = [];
    mock.module("@workbench/tools-sumble", () => ({
      SUMBLE_HUB_TOOLS: {
        sumble_get_organization_list: {
          createTools: () => [
            {
              kind: "full" as const,
              definition: { name: "sumble_get_organization_list" },
              handler: async (call: {
                id: string;
                arguments?: Record<string, unknown>;
              }) => {
                seen.push(call.arguments?.listId);
                return {
                  callId: call.id,
                  isError: false,
                  content: { organizations: [] },
                };
              },
            },
          ],
        },
        sumble_add_organization_list_organizations: { createTools: () => [] },
      },
    }));
    const { prospectEngineSumbleListBridge } = await import("./bridges");
    const runner = prospectEngineSumbleListBridge(SUMBLE_ENV as never);
    const signal = new AbortController().signal;

    for (const arguments_ of [
      { growthEngineListId: 111 },
      { enterpriseEngineListId: "222" },
      { listId: 333 },
    ]) {
      const result = await runner.run(
        {
          id: "call1",
          name: "prospect_engine_read_organization_list_tolerant",
          arguments: arguments_,
        },
        signal,
      );
      expect(result.isError).toBe(false);
    }

    expect(seen).toEqual([111, 222, 333]);
  });
});

describe("prospectEngineSumbleAddBridge", () => {
  afterEach(() => {
    mock.restore();
  });

  test("picks the growth lane's listId/organizationIds and never throws on failure", async () => {
    mock.module("@workbench/tools-sumble", () => ({
      SUMBLE_HUB_TOOLS: {
        sumble_get_organization_list: { createTools: () => [] },
        sumble_add_organization_list_organizations: {
          createTools: () => [
            {
              kind: "full" as const,
              definition: {
                name: "sumble_add_organization_list_organizations",
              },
              handler: async () => {
                throw new Error("write failed");
              },
            },
          ],
        },
      },
    }));
    const { prospectEngineSumbleAddBridge } = await import("./bridges");
    const runner = prospectEngineSumbleAddBridge(SUMBLE_ENV as never);
    const result = await runner.run(
      {
        id: "call1",
        name: "prospect_engine_add_organization_list_tolerant",
        arguments: {
          lane: "growth",
          growthEngineListId: "growth_list",
          enterpriseEngineListId: "enterprise_list",
          growthOrganizationIds: [1, 2],
          enterpriseOrganizationIds: [3, 4],
        },
      },
      new AbortController().signal,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toMatchObject({
      isError: true,
      error: expect.stringContaining("write failed"),
    });
  });
});
