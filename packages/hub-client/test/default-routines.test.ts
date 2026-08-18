import { describe, expect, test } from "bun:test";
import { CliError } from "../src/errors";
import {
  DEFAULT_ROUTINE_PRESETS,
  ensureDefaultRoutines,
} from "../src/default-routines";
import { collector, fakeAPI, TENANT_ID, type FakeHandler } from "./helpers";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function definitionRow(id: string, name: string, status = "deployed") {
  return {
    id,
    tenantId: TENANT_ID,
    name,
    description: null,
    currentVersion: "1",
    status,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function routineRow(overrides: {
  id: string;
  name: string;
  deliveryChannelId?: string | null;
  enabled?: boolean;
}) {
  return {
    id: overrides.id,
    name: overrides.name,
    enabled: overrides.enabled ?? true,
    deliveryChannelId: overrides.deliveryChannelId ?? null,
  };
}

describe("DEFAULT_ROUTINE_PRESETS", () => {
  test("declares the daily digest and the un-stranded last-30-days-research presets", () => {
    expect(DEFAULT_ROUTINE_PRESETS.map((p) => p.name)).toEqual([
      "Daily digest",
      "Last 30 days research",
    ]);
  });

  test("targets the channel-digest and last-30-days-research assets", () => {
    expect(DEFAULT_ROUTINE_PRESETS.map((p) => p.assetName)).toEqual([
      "channel-digest",
      "last-30-days-research",
    ]);
  });

  test("last-30-days-research is a manual, run-now-only preset", () => {
    const research = DEFAULT_ROUTINE_PRESETS.find(
      (p) => p.assetName === "last-30-days-research",
    );
    expect(research?.trigger).toBeNull();
  });

  test("daily digest fires on a fixed daily cadence", () => {
    const digest = DEFAULT_ROUTINE_PRESETS.find(
      (p) => p.assetName === "channel-digest",
    );
    expect(digest?.trigger).toEqual({ kind: "daily", hour: 9, minute: 0 });
  });
});

describe("ensureDefaultRoutines", () => {
  test("creates every preset disabled, sharing the first preset's delivery channel", async () => {
    const { lines, log } = collector();
    const createCalls: { name: string; body: unknown }[] = [];
    const patchCalls: { id: string; body: unknown }[] = [];
    let nextRoutineId = 1;

    const handler: FakeHandler = (method, path, body) => {
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/definitions`
      ) {
        return {
          status: 200,
          data: {
            data: [
              definitionRow("wfd_digest", "channel-digest"),
              definitionRow("wfd_research", "last-30-days-research"),
            ],
            nextCursor: null,
          },
        };
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/routines`) {
        return { status: 200, data: { items: [] } };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/routines`) {
        const parsed = body as { name: string };
        createCalls.push({ name: parsed.name, body });
        const id = `rtn_${nextRoutineId}`;
        nextRoutineId += 1;
        // Every preset after the first names the shared channel
        // explicitly; the first preset names none, so the space it
        // would have been auto-provisioned into is stood in here as a
        // fixed id the test can assert every later preset reuses.
        const deliveryChannelId =
          (parsed as { deliveryChannelId?: string }).deliveryChannelId ??
          "ch_provisioned";
        return {
          status: 201,
          data: routineRow({ id, name: parsed.name, deliveryChannelId }),
        };
      }
      if (
        method === "PATCH" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/routines/`)
      ) {
        const id = path.split("/").pop() ?? "";
        patchCalls.push({ id, body });
        return { status: 200, data: {} };
      }
      return undefined;
    };

    await ensureDefaultRoutines(fakeAPI(handler), [], TENANT_ID, log);

    expect(createCalls).toHaveLength(2);
    expect(createCalls[0]?.name).toBe("Daily digest");
    expect(createCalls[0]?.body).not.toHaveProperty("deliveryChannelId");
    expect(createCalls[1]?.name).toBe("Last 30 days research");
    expect(createCalls[1]?.body).toMatchObject({
      deliveryChannelId: "ch_provisioned",
    });

    expect(patchCalls).toHaveLength(2);
    for (const patch of patchCalls) {
      expect(patch.body).toEqual({ enabled: false });
    }

    const output = lines.join("\n");
    expect(output).toContain('seeded routine "Daily digest" (disabled)');
    expect(output).toContain(
      'seeded routine "Last 30 days research" (disabled)',
    );
  });

  test("skips a preset whose workflow was never deployed", async () => {
    const { lines, log } = collector();
    const handler: FakeHandler = (method, path) => {
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/definitions`
      ) {
        return { status: 200, data: { data: [], nextCursor: null } };
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/routines`) {
        return { status: 200, data: { items: [] } };
      }
      return undefined;
    };

    await ensureDefaultRoutines(fakeAPI(handler), [], TENANT_ID, log);

    const output = lines.join("\n");
    expect(output).toContain(
      'routine "Daily digest" skipped: no deployed definition named "channel-digest"',
    );
    expect(output).toContain(
      'routine "Last 30 days research" skipped: no deployed definition named "last-30-days-research"',
    );
  });

  test("a re-seed finds every preset already present and creates nothing twice", async () => {
    const { lines, log } = collector();
    const handler: FakeHandler = (method, path) => {
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/definitions`
      ) {
        return {
          status: 200,
          data: {
            data: [
              definitionRow("wfd_digest", "channel-digest"),
              definitionRow("wfd_research", "last-30-days-research"),
            ],
            nextCursor: null,
          },
        };
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/routines`) {
        return {
          status: 200,
          data: {
            items: [
              routineRow({
                id: "rtn_1",
                name: "Daily digest",
                deliveryChannelId: "ch_existing",
                enabled: false,
              }),
              routineRow({
                id: "rtn_2",
                name: "Last 30 days research",
                deliveryChannelId: "ch_existing",
                enabled: false,
              }),
            ],
          },
        };
      }
      if (method === "POST" || method === "PATCH") {
        throw new Error(
          `must not touch routines on a re-seed: ${method} ${path}`,
        );
      }
      return undefined;
    };

    await ensureDefaultRoutines(fakeAPI(handler), [], TENANT_ID, log);

    const output = lines.join("\n");
    expect(output).toContain('routine "Daily digest" already exists (skipped)');
    expect(output).toContain(
      'routine "Last 30 days research" already exists (skipped)',
    );
  });

  test("a non-201 create response is a loud failure naming the preset", async () => {
    const { log } = collector();
    const handler: FakeHandler = (method, path) => {
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/definitions`
      ) {
        return {
          status: 200,
          data: {
            data: [definitionRow("wfd_digest", "channel-digest")],
            nextCursor: null,
          },
        };
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/routines`) {
        return { status: 200, data: { items: [] } };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/routines`) {
        return { status: 400, data: { error: "bad request" } };
      }
      return undefined;
    };

    expect(
      ensureDefaultRoutines(fakeAPI(handler), [], TENANT_ID, log),
    ).rejects.toThrow(CliError);
  });
});
