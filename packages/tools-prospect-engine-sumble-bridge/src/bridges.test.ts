import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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
        arguments: "list_123" as unknown as Record<string, unknown>,
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
    mock.module("@workbench/tools-sumble", () => ({
      SUMBLE_HUB_TOOLS: {
        sumble_get_organization_list: {
          createTools: () => [
            {
              kind: "full" as const,
              definition: { name: "sumble_get_organization_list" },
              handler: async (call: { id: string }) => ({
                callId: call.id,
                isError: false,
                content: { organizations: [{ organizationId: 42 }] },
              }),
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
        arguments: "list_123" as unknown as Record<string, unknown>,
      },
      new AbortController().signal,
    );
    expect(result.isError).toBe(false);
    expect(extractOrganizationIds(result.content)).toEqual([42]);
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
