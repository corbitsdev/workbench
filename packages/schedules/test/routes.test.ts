// Mounts `createScheduleRoutes` into a bare `Hono` with fake
// store/launcher deps, exercising the route surface: request parsing,
// grant checks, and HTTP envelope mapping. Cron/interval arithmetic is
// covered in `trigger.test.ts`; this file never re-tests it beyond the
// route's own 400-on-invalid-trigger behavior.
import { describe, expect, test } from "bun:test";
import { createScheduleRoutes } from "../src/routes";
import { buildDeps, fakeLauncher, mountAs, TENANT } from "./test-support";

const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");

describe("POST /schedules", () => {
  test("creates a schedule and computes its first nextRunAt", async () => {
    const deps = buildDeps({ now: () => FIXED_NOW });
    const app = mountAs(createScheduleRoutes(deps), "prn_alice");

    const response = await app.request("/schedules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflowDefinitionId: "wfd_report",
        trigger: { kind: "cron", expression: "0 * * * *" },
        input: { channel: "#ops" },
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      id: string;
      enabled: boolean;
      nextRunAt: string;
      createdBy: string;
    };
    expect(body.enabled).toBe(true);
    expect(body.createdBy).toBe("prn_alice");
    expect(body.nextRunAt).toBe("2026-01-01T01:00:00.000Z");

    const stored = await deps.store.get(TENANT.id, body.id);
    expect(stored?.workflowDefinitionId).toBe("wfd_report");
  });

  test("rejects a malformed body with the structured error envelope", async () => {
    const app = mountAs(createScheduleRoutes(buildDeps()), "prn_alice");

    const response = await app.request("/schedules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        trigger: { kind: "cron", expression: "* * * * *" },
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });

  test("rejects an unparsable cron expression", async () => {
    const app = mountAs(createScheduleRoutes(buildDeps()), "prn_alice");

    const response = await app.request("/schedules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflowDefinitionId: "wfd_report",
        trigger: { kind: "cron", expression: "nonsense" },
      }),
    });

    expect(response.status).toBe(400);
  });

  test("rejects a non-positive interval", async () => {
    const app = mountAs(createScheduleRoutes(buildDeps()), "prn_alice");

    const response = await app.request("/schedules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflowDefinitionId: "wfd_report",
        trigger: { kind: "interval", ms: 0 },
      }),
    });

    expect(response.status).toBe(400);
  });

  test("a denied grant is rejected before any schedule is created", async () => {
    const deps = buildDeps({
      requireGrant: () => async (c) =>
        c.json({ error: { code: "forbidden", message: "no" } }, 403),
    });
    const app = mountAs(createScheduleRoutes(deps), "prn_alice");

    const response = await app.request("/schedules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflowDefinitionId: "wfd_report",
        trigger: { kind: "interval", ms: 60_000 },
      }),
    });

    expect(response.status).toBe(403);
  });
});

describe("GET /schedules", () => {
  test("lists only the requesting tenant's schedules", async () => {
    const deps = buildDeps({ now: () => FIXED_NOW });
    const app = mountAs(createScheduleRoutes(deps), "prn_alice");

    await deps.store.create({
      id: "sch_other",
      tenantId: "tnt_other",
      workflowDefinitionId: "wfd_x",
      trigger: { kind: "interval", ms: 60_000 },
      input: null,
      enabled: true,
      createdBy: "prn_bob",
      nextRunAt: FIXED_NOW,
    });
    await app.request("/schedules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflowDefinitionId: "wfd_report",
        trigger: { kind: "interval", ms: 60_000 },
      }),
    });

    const response = await app.request("/schedules");
    const body = (await response.json()) as { items: { id: string }[] };
    expect(body.items).toHaveLength(1);
  });
});

describe("PATCH /schedules/:id", () => {
  test("disables a schedule without touching its trigger", async () => {
    const deps = buildDeps({ now: () => FIXED_NOW });
    const app = mountAs(createScheduleRoutes(deps), "prn_alice");
    const created = await deps.store.create({
      id: "sch_1",
      tenantId: TENANT.id,
      workflowDefinitionId: "wfd_report",
      trigger: { kind: "interval", ms: 60_000 },
      input: null,
      enabled: true,
      createdBy: "prn_alice",
      nextRunAt: FIXED_NOW,
    });

    const response = await app.request(`/schedules/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      enabled: boolean;
      trigger: unknown;
    };
    expect(body.enabled).toBe(false);
    expect(body.trigger).toEqual({ kind: "interval", ms: 60_000 });
  });

  test("404s for a schedule in another tenant", async () => {
    const deps = buildDeps();
    const app = mountAs(createScheduleRoutes(deps), "prn_alice");
    await deps.store.create({
      id: "sch_foreign",
      tenantId: "tnt_other",
      workflowDefinitionId: "wfd_x",
      trigger: { kind: "interval", ms: 60_000 },
      input: null,
      enabled: true,
      createdBy: "prn_bob",
      nextRunAt: FIXED_NOW,
    });

    const response = await app.request("/schedules/sch_foreign", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });

    expect(response.status).toBe(404);
  });

  test("rejects an invalid trigger patch", async () => {
    const deps = buildDeps({ now: () => FIXED_NOW });
    const app = mountAs(createScheduleRoutes(deps), "prn_alice");
    const created = await deps.store.create({
      id: "sch_2",
      tenantId: TENANT.id,
      workflowDefinitionId: "wfd_report",
      trigger: { kind: "interval", ms: 60_000 },
      input: null,
      enabled: true,
      createdBy: "prn_alice",
      nextRunAt: FIXED_NOW,
    });

    const response = await app.request(`/schedules/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trigger: { kind: "interval", ms: -5 } }),
    });

    expect(response.status).toBe(400);
  });
});

describe("DELETE /schedules/:id", () => {
  test("deletes an existing schedule", async () => {
    const deps = buildDeps({ now: () => FIXED_NOW });
    const app = mountAs(createScheduleRoutes(deps), "prn_alice");
    const created = await deps.store.create({
      id: "sch_3",
      tenantId: TENANT.id,
      workflowDefinitionId: "wfd_report",
      trigger: { kind: "interval", ms: 60_000 },
      input: null,
      enabled: true,
      createdBy: "prn_alice",
      nextRunAt: FIXED_NOW,
    });

    const response = await app.request(`/schedules/${created.id}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(204);
    expect(await deps.store.get(TENANT.id, created.id)).toBeUndefined();
  });
});

describe("POST /schedules/:id/run-now", () => {
  test("launches immediately without disturbing the schedule's cadence", async () => {
    const launcher = fakeLauncher();
    const deps = buildDeps({ launcher, now: () => FIXED_NOW });
    const app = mountAs(createScheduleRoutes(deps), "prn_alice");
    const future = new Date(FIXED_NOW.getTime() + 60_000);
    const created = await deps.store.create({
      id: "sch_4",
      tenantId: TENANT.id,
      workflowDefinitionId: "wfd_report",
      trigger: { kind: "interval", ms: 60_000 },
      input: { note: "hi" },
      enabled: true,
      createdBy: "prn_alice",
      nextRunAt: future,
    });

    const response = await app.request(`/schedules/${created.id}/run-now`, {
      method: "POST",
    });

    expect(response.status).toBe(201);
    expect(launcher.calls).toHaveLength(1);
    expect(launcher.calls[0]?.input).toEqual({ note: "hi" });

    const after = await deps.store.get(TENANT.id, created.id);
    expect(after?.nextRunAt.getTime()).toBe(future.getTime());
    expect(after?.lastRunAt?.getTime()).toBe(FIXED_NOW.getTime());
  });
});
