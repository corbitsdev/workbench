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
  deliveryWorkbenchId?: string | null;
  enabled?: boolean;
}) {
  return {
    id: overrides.id,
    name: overrides.name,
    enabled: overrides.enabled ?? true,
    deliveryWorkbenchId: overrides.deliveryWorkbenchId ?? null,
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
  test("creates every preset disabled, sharing the first preset's delivery workbench", async () => {
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
              definitionRow("wfd_digest", "workbench-digest"),
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
        // Every preset after the first names the shared workbench
        // explicitly; the first preset names none, so the space it
        // would have been auto-provisioned into is stood in here as a
        // fixed id the test can assert every later preset reuses.
        const deliveryWorkbenchId =
          (parsed as { deliveryWorkbenchId?: string }).deliveryWorkbenchId ??
          "ch_provisioned";
        return {
          status: 201,
          data: routineRow({ id, name: parsed.name, deliveryWorkbenchId }),
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
    expect(createCalls[0]?.body).not.toHaveProperty("deliveryWorkbenchId");
    expect(createCalls[1]?.name).toBe("Last 30 days research");
    expect(createCalls[1]?.body).toMatchObject({
      deliveryWorkbenchId: "ch_provisioned",
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
      'routine "Daily digest" skipped: no deployed definition named "workbench-digest"',
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
              definitionRow("wfd_digest", "workbench-digest"),
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
                deliveryWorkbenchId: "ch_existing",
                enabled: false,
              }),
              routineRow({
                id: "rtn_2",
                name: "Last 30 days research",
                deliveryWorkbenchId: "ch_existing",
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
          data: routineRow({ id: "rtn_1", name: "Daily digest" }),
        };
      }
      if (
        method === "PATCH" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/routines/`)
      ) {
        return { status: 200, data: {} };
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
  // must read a 200 as "already exists" — no duplicate disable, no
  // treating it as a fresh seed.
  test("a 200 create response (lost the create-if-absent race) is treated as already-seeded, not re-disabled", async () => {
    const { lines, log } = collector();
    const patchCalls: { id: string }[] = [];
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
          }),
        };
      }
      if (
        method === "PATCH" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/routines/`)
      ) {
        patchCalls.push({ id: path.split("/").pop() ?? "" });
        return { status: 200, data: {} };
      }
      return undefined;
    };

    await ensureDefaultRoutines(fakeAPI(handler), [], TENANT_ID, log);

    expect(patchCalls).toHaveLength(0);
    expect(lines.join("\n")).toContain(
      'routine "Daily digest" already exists (skipped)',
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
