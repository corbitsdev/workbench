import { expect, test } from "bun:test";

import type { DB } from "@intx/db";
import type { AssetService } from "@intx/hub-sessions";

import {
  captureWorldSnapshot,
  type WorldSnapshotInfra,
} from "./world-snapshot.ts";

type FakeTables = {
  workflowDefinitions: {
    id: string;
    name: string;
    description: string | null;
    assetId: string | null;
  }[];
  routines: {
    id: string;
    tenantId: string;
    name: string;
    definitionId: string;
    trigger: unknown;
    deliveryWorkbenchId: string | null;
    enabled: boolean;
    deletedAt: Date | null;
  }[];
  providers: {
    id: string;
    tenantId: string;
    name: string;
    apiBaseUrl: string | null;
  }[];
  credentials: {
    id: string;
    tenantId: string;
    providerId: string;
    name: string;
    status: string;
  }[];
  workflowBlobs: Record<string, string>;
};

function fakeDb(tables: FakeTables): DB["db"] {
  return {
    query: {
      workflowDefinition: {
        findMany: async () => tables.workflowDefinitions,
      },
      tenant: {
        findFirst: async () => ({ parentId: null }),
      },
      provider: {
        findMany: async () => tables.providers,
      },
      credential: {
        findMany: async () => tables.credentials,
      },
    },
    select: () => ({
      from: () => ({
        where: async () => tables.routines,
      }),
    }),
  } as unknown as DB["db"];
}

function fakeAssetService(blobs: Record<string, string>): AssetService {
  return {
    readAssetBlob: async ({ assetId }: { assetId: string }) =>
      new TextEncoder().encode(blobs[assetId] ?? "{}"),
  } as unknown as AssetService;
}

function workflowJsonWith(
  toolPackagePins: { name: string; version: string }[],
  model?: string,
) {
  return JSON.stringify({
    steps: {
      agent: {
        agent: {
          systemPrompt: "You are a helpful agent.",
          toolPackagePins,
          ...(model === undefined
            ? {}
            : { inference: { sources: [{ provider: "anthropic", model }] } }),
        },
      },
    },
  });
}

function emptyTables(): FakeTables {
  return {
    workflowDefinitions: [],
    routines: [],
    providers: [],
    credentials: [],
    workflowBlobs: {},
  };
}

test("captureWorldSnapshot reads agent definitions with their capabilities", async () => {
  const tables = emptyTables();
  tables.workflowDefinitions = [
    {
      id: "def-1",
      name: "ai-daily-research",
      description: "AI Daily researcher",
      assetId: "asset-1",
    },
  ];
  const infra: WorldSnapshotInfra = {
    db: fakeDb(tables),
    assetService: fakeAssetService({
      "asset-1": workflowJsonWith(
        [{ name: "@corbits/web-search-tools", version: "0.0.1" }],
        "claude-3-5-sonnet",
      ),
    }),
  };
  const world = await captureWorldSnapshot(infra, "tenant-1");
  expect(world.agentDefinitions).toEqual([
    {
      id: "def-1",
      name: "AI Daily researcher",
      toolPackagePins: ["@corbits/web-search-tools"],
      skills: [],
      model: "claude-3-5-sonnet",
    },
  ]);
});

test("captureWorldSnapshot skips a definition with no materialized asset", async () => {
  const tables = emptyTables();
  tables.workflowDefinitions = [
    { id: "def-1", name: "draft", description: null, assetId: null },
  ];
  const infra: WorldSnapshotInfra = {
    db: fakeDb(tables),
    assetService: fakeAssetService({}),
  };
  const world = await captureWorldSnapshot(infra, "tenant-1");
  expect(world.agentDefinitions).toEqual([]);
});

test("captureWorldSnapshot reads routines with their trigger and delivery", async () => {
  const tables = emptyTables();
  tables.routines = [
    {
      id: "r-1",
      tenantId: "tenant-1",
      name: "Daily digest",
      definitionId: "def-1",
      trigger: { kind: "daily", time: "09:00" },
      deliveryWorkbenchId: "wb-1",
      enabled: true,
      deletedAt: null,
    },
  ];
  const infra: WorldSnapshotInfra = {
    db: fakeDb(tables),
    assetService: fakeAssetService({}),
  };
  const world = await captureWorldSnapshot(infra, "tenant-1");
  expect(world.routines).toEqual([
    {
      id: "r-1",
      name: "Daily digest",
      definitionId: "def-1",
      trigger: { kind: "daily", time: "09:00" },
      deliveryWorkbenchId: "wb-1",
      enabled: true,
    },
  ]);
});

test("captureWorldSnapshot reads live MCP connections", async () => {
  const tables = emptyTables();
  tables.providers = [
    {
      id: "p-1",
      tenantId: "tenant-1",
      name: "mcp:github",
      apiBaseUrl: "https://fake/mcp",
    },
  ];
  tables.credentials = [
    {
      id: "c-1",
      tenantId: "tenant-1",
      providerId: "p-1",
      name: "GitHub",
      status: "active",
    },
  ];
  const infra: WorldSnapshotInfra = {
    db: fakeDb(tables),
    assetService: fakeAssetService({}),
  };
  const world = await captureWorldSnapshot(infra, "tenant-1");
  expect(world.connections).toEqual([
    { slug: "github", name: "GitHub", url: "https://fake/mcp", live: true },
  ]);
});

test("captureWorldSnapshot folds in fake receipts from the injected reader", async () => {
  const infra: WorldSnapshotInfra = {
    db: fakeDb(emptyTables()),
    assetService: fakeAssetService({}),
    fakeReceiptsReader: () => [
      { server: "github", toolName: "list_pull_requests", arguments: {} },
    ],
  };
  const world = await captureWorldSnapshot(infra, "tenant-1");
  expect(world.fakeReceipts).toEqual([
    { server: "github", toolName: "list_pull_requests", arguments: {} },
  ]);
});

test("captureWorldSnapshot returns an empty, well-formed snapshot for a tenant with nothing yet", async () => {
  const infra: WorldSnapshotInfra = {
    db: fakeDb(emptyTables()),
    assetService: fakeAssetService({}),
  };
  const world = await captureWorldSnapshot(infra, "tenant-1");
  expect(world.agentDefinitions).toEqual([]);
  expect(world.routines).toEqual([]);
  expect(world.connections).toEqual([]);
  expect(world.fakeReceipts).toEqual([]);
  expect(typeof world.capturedAt).toBe("string");
});
