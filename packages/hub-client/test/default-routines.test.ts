import { describe, expect, test } from "bun:test";
import { CliError } from "../src/errors";
import {
  DEFAULT_ROUTINE_PRESETS,
  ensureDefaultRoutines,
} from "../src/default-routines";
import { collector, fakeAPI, TENANT_ID, type FakeHandler } from "./helpers";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";
const TOUCHED_TIMESTAMP = "2026-01-02T12:00:00.000Z";

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
  deliveryWorkbenchId?: string | null;
  enabled?: boolean;
  presetKey?: string | null;
  updatedAt?: string;
}) {
  return {
    id: overrides.id,
    name: overrides.name,
    enabled: overrides.enabled ?? true,
    deliveryWorkbenchId: overrides.deliveryWorkbenchId ?? null,
    presetKey: overrides.presetKey ?? null,
    createdAt: TIMESTAMP,
    updatedAt: overrides.updatedAt ?? TIMESTAMP,
  };
}

function deployedDefinitionsResponse() {
  return {
    status: 200,
    data: {
      data: [
        definitionRow("wfd_digest", "workbench-digest"),
        definitionRow("wfd_research", "last-30-days-research"),
      ],
      nextCursor: null,
    },
  };
}

describe("DEFAULT_ROUTINE_PRESETS", () => {
  test("declares the daily digest and the un-stranded last-30-days-research presets", () => {
    expect(DEFAULT_ROUTINE_PRESETS.map((p) => p.name)).toEqual([
      "Daily digest",
      "Last 30 days research",
    ]);
  });

  test("targets the workbench-digest and last-30-days-research assets", () => {
    expect(DEFAULT_ROUTINE_PRESETS.map((p) => p.assetName)).toEqual([
      "workbench-digest",
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
      (p) => p.assetName === "workbench-digest",
    );
    expect(digest?.trigger).toEqual({ kind: "daily", hour: 9, minute: 0 });
  });
});

describe("ensureDefaultRoutines", () => {
  test("plants every preset once, born disabled server-side, never PATCHed, sharing the first preset's delivery workbench", async () => {
    const { lines, log } = collector();
    const createCalls: { name: string; body: unknown }[] = [];
    let nextRoutineId = 1;

    const handler: FakeHandler = (method, path, body) => {
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/definitions`
      ) {
        return deployedDefinitionsResponse();
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/routines`) {
        return { status: 200, data: { items: [] } };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/routines`) {
        const parsed = body as { name: string; presetKey: string };
        createCalls.push({ name: parsed.name, body });
        const id = `rtn_${nextRoutineId}`;
        nextRoutineId += 1;
        // Every preset after the first names the shared workbench
        // explicitly; the first preset names none, so the space it
        // would have been auto-provisioned into is stood in here as a
        // fixed id the test can assert every later preset reuses.
        const deliveryWorkbenchId =
          (parsed as { deliveryWorkbenchId?: string }).deliveryWorkbenchId ??
          "ch_provisioned";
        return {
          status: 201,
          data: routineRow({
            id,
            name: parsed.name,
            deliveryWorkbenchId,
            enabled: false,
            presetKey: parsed.presetKey,
          }),
        };
      }
      return undefined;
    };

    await ensureDefaultRoutines(fakeAPI(handler), [], TENANT_ID, log);

    expect(createCalls).toHaveLength(2);
    expect(createCalls[0]?.name).toBe("Daily digest");
    expect(createCalls[0]?.body).not.toHaveProperty("deliveryWorkbenchId");
    expect(createCalls[0]?.body).not.toHaveProperty("enabled");
    expect(createCalls[1]?.name).toBe("Last 30 days research");
    expect(createCalls[1]?.body).toMatchObject({
      deliveryWorkbenchId: "ch_provisioned",
    });

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
      'routine "Daily digest" skipped: no deployed definition named "workbench-digest"',
    );
    expect(output).toContain(
      'routine "Last 30 days research" skipped: no deployed definition named "last-30-days-research"',
    );
  });

  test("a re-seed matches every preset by presetKey — even renamed — and creates nothing twice", async () => {
    const { lines, log } = collector();
    const handler: FakeHandler = (method, path) => {
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/definitions`
      ) {
        return deployedDefinitionsResponse();
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/routines`) {
        return {
          status: 200,
          data: {
            items: [
              routineRow({
                id: "rtn_1",
                name: "My renamed digest",
                deliveryWorkbenchId: "ch_existing",
                enabled: false,
                presetKey: "workbench-digest",
              }),
              routineRow({
                id: "rtn_2",
                name: "Last 30 days research",
                deliveryWorkbenchId: "ch_existing",
                enabled: false,
                presetKey: "last-30-days-research",
              }),
            ],
          },
        };
      }
      throw new Error(`must not touch routines on a re-seed: ${method} ${path}`);
    };

    await ensureDefaultRoutines(fakeAPI(handler), [], TENANT_ID, log);

    const output = lines.join("\n");
    expect(output).toContain('routine "Daily digest" already exists (skipped)');
    expect(output).toContain(
      'routine "Last 30 days research" already exists (skipped)',
    );
  });

  test("a legacy row without a presetKey is matched by name, never re-planted", async () => {
    const { log } = collector();
    const handler: FakeHandler = (method, path) => {
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/definitions`
      ) {
        return deployedDefinitionsResponse();
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/routines`) {
        return {
          status: 200,
          data: {
            items: DEFAULT_ROUTINE_PRESETS.map((preset, index) =>
              routineRow({
                id: `rtn_${index}`,
                name: preset.name,
                enabled: false,
                presetKey: null,
              }),
            ),
          },
        };
      }
      throw new Error(`must not touch legacy rows: ${method} ${path}`);
    };

    await ensureDefaultRoutines(fakeAPI(handler), [], TENANT_ID, log);
  });

  test("sends each preset's assetName as presetKey — the create-if-absent identity", async () => {
    const { log } = collector();
    const createCalls: { body: unknown }[] = [];
    const handler: FakeHandler = (method, path, body) => {
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/definitions`
      ) {
        return {
          status: 200,
          data: {
            data: [definitionRow("wfd_digest", "workbench-digest")],
            nextCursor: null,
          },
        };
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/routines`) {
        return { status: 200, data: { items: [] } };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/routines`) {
        createCalls.push({ body });
        return {
          status: 201,
          data: routineRow({
            id: "rtn_1",
            name: "Daily digest",
            enabled: false,
            presetKey: "workbench-digest",
          }),
        };
      }
      return undefined;
    };

    await ensureDefaultRoutines(fakeAPI(handler), [], TENANT_ID, log);

    expect(createCalls[0]?.body).toMatchObject({
      presetKey: "workbench-digest",
    });
  });

  // CL-6375: even when the app-level "already present" check races
  // (two overlapping seed calls both list zero existing routines, so
  // both POST), the server's own create-if-absent guarantee means only
  // one of the two POSTs actually mints a row. `ensureDefaultRoutines`
  // must read a 200 as "already exists" and leave the row alone.
  test("a 200 create response (lost the create-if-absent race) is treated as already-seeded", async () => {
    const { lines, log } = collector();
    const handler: FakeHandler = (method, path) => {
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/definitions`
      ) {
        return {
          status: 200,
          data: {
            data: [definitionRow("wfd_digest", "workbench-digest")],
            nextCursor: null,
          },
        };
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/routines`) {
        // The app-level pre-check itself raced and saw nothing yet —
        // the server is the one that actually caught the duplicate.
        return { status: 200, data: { items: [] } };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/routines`) {
        return {
          status: 200,
          data: routineRow({
            id: "rtn_winner",
            name: "Daily digest",
            deliveryWorkbenchId: "ch_winner",
            enabled: false,
            presetKey: "workbench-digest",
          }),
        };
      }
      return undefined;
    };

    await ensureDefaultRoutines(fakeAPI(handler), [], TENANT_ID, log);

    expect(lines.join("\n")).toContain(
      'routine "Daily digest" already exists (skipped)',
    );
  });

  // CL-6400: a member deleting a preset routine is a decision, not a
  // gap for the next seed pass to fill back in. The hub answers such a
  // create with 204 and no row; the seed respects it.
  test("a preset the member deleted stays deleted (204 is respected, not fatal)", async () => {
    const { lines, log } = collector();
    let posts = 0;
    const handler: FakeHandler = (method, path) => {
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/definitions`
      ) {
        return deployedDefinitionsResponse();
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/routines`) {
        return { status: 200, data: { items: [] } };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/routines`) {
        posts += 1;
        return { status: 204, data: undefined };
      }
      return undefined;
    };

    await ensureDefaultRoutines(fakeAPI(handler), [], TENANT_ID, log);

    expect(posts).toBe(DEFAULT_ROUTINE_PRESETS.length);
    expect(lines.join("\n")).toContain("removed by a member (respected)");
  });

  test("a pristine routine for a preset that no longer ships is deleted; a member-touched one is kept", async () => {
    const { lines, log } = collector();
    const deleteCalls: string[] = [];
    const handler: FakeHandler = (method, path) => {
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/definitions`
      ) {
        return deployedDefinitionsResponse();
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/routines`) {
        return {
          status: 200,
          data: {
            items: [
              routineRow({
                id: "rtn_pristine_orphan",
                name: "Old preset",
                enabled: false,
                presetKey: "retired-preset",
              }),
              routineRow({
                id: "rtn_touched_orphan",
                name: "Old preset I tuned",
                enabled: true,
                presetKey: "other-retired-preset",
                updatedAt: TOUCHED_TIMESTAMP,
              }),
              ...DEFAULT_ROUTINE_PRESETS.map((preset, index) =>
                routineRow({
                  id: `rtn_${index}`,
                  name: preset.name,
                  enabled: false,
                  presetKey: preset.assetName,
                }),
              ),
            ],
          },
        };
      }
      if (
        method === "DELETE" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/routines/`)
      ) {
        deleteCalls.push(path.split("/").pop() ?? "");
        return { status: 204, data: undefined };
      }
      return undefined;
    };

    await ensureDefaultRoutines(fakeAPI(handler), [], TENANT_ID, log);

    expect(deleteCalls).toEqual(["rtn_pristine_orphan"]);
    const output = lines.join("\n");
    expect(output).toContain(
      'routine "Old preset" retired (its preset no longer ships)',
    );
    expect(output).toContain(
      'routine "Old preset I tuned" outlived its preset but was touched by a member (kept)',
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
            data: [definitionRow("wfd_digest", "workbench-digest")],
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
