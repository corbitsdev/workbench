import { describe, expect, test } from "bun:test";
import { HubApiError } from "@corbits/hub-api-client";
import { pruneDroppedPresetRoutines } from "../src/default-routines";
import { collector, fakeAPI, TENANT_ID, type FakeHandler } from "./helpers";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";
const TOUCHED_TIMESTAMP = "2026-01-02T12:00:00.000Z";

function routineRow(overrides: {
  id: string;
  name: string;
  presetKey?: string | null;
  updatedAt?: string;
}) {
  return {
    id: overrides.id,
    name: overrides.name,
    presetKey: overrides.presetKey ?? null,
    createdAt: TIMESTAMP,
    updatedAt: overrides.updatedAt ?? TIMESTAMP,
  };
}

describe("pruneDroppedPresetRoutines", () => {
  test("never POSTs /routines", async () => {
    const { log } = collector();
    let posts = 0;
    const handler: FakeHandler = (method, path) => {
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/routines`) {
        posts += 1;
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/routines`) {
        return { status: 200, data: { items: [] } };
      }
      throw new Error(`unexpected hub call: ${method} ${path}`);
    };

    await pruneDroppedPresetRoutines(fakeAPI(handler), [], TENANT_ID, log);

    expect(posts).toBe(0);
  });

  test("deletes pristine workbench-digest and last-30-days-research leftover wrappers", async () => {
    const { lines, log } = collector();
    const deleteCalls: string[] = [];
    const handler: FakeHandler = (method, path) => {
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/routines`) {
        return {
          status: 200,
          data: {
            items: [
              routineRow({
                id: "rtn_digest",
                name: "Daily digest",
                presetKey: "workbench-digest",
              }),
              routineRow({
                id: "rtn_research",
                name: "Last 30 days research",
                presetKey: "last-30-days-research",
              }),
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
      throw new Error(`unexpected hub call: ${method} ${path}`);
    };

    await pruneDroppedPresetRoutines(fakeAPI(handler), [], TENANT_ID, log);

    expect(deleteCalls).toEqual(["rtn_digest", "rtn_research"]);
    const output = lines.join("\n");
    expect(output).toContain(
      'routine "Daily digest" retired (its preset no longer ships)',
    );
    expect(output).toContain(
      'routine "Last 30 days research" retired (its preset no longer ships)',
    );
  });

  test("keeps a member-touched retired-preset row", async () => {
    const { lines, log } = collector();
    const deleteCalls: string[] = [];
    const handler: FakeHandler = (method, path) => {
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/routines`) {
        return {
          status: 200,
          data: {
            items: [
              routineRow({
                id: "rtn_digest_touched",
                name: "Daily digest I tuned",
                presetKey: "workbench-digest",
                updatedAt: TOUCHED_TIMESTAMP,
              }),
              routineRow({
                id: "rtn_research_touched",
                name: "Research I tuned",
                presetKey: "last-30-days-research",
                updatedAt: TOUCHED_TIMESTAMP,
              }),
              routineRow({
                id: "rtn_digest_pristine",
                name: "Daily digest",
                presetKey: "workbench-digest",
              }),
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
      throw new Error(`unexpected hub call: ${method} ${path}`);
    };

    await pruneDroppedPresetRoutines(fakeAPI(handler), [], TENANT_ID, log);

    expect(deleteCalls).toEqual(["rtn_digest_pristine"]);
    const output = lines.join("\n");
    expect(output).toContain(
      'routine "Daily digest I tuned" outlived its preset but was touched by a member (kept)',
    );
    expect(output).toContain(
      'routine "Research I tuned" outlived its preset but was touched by a member (kept)',
    );
  });

  test("keeps a pre-presetKey legacy row", async () => {
    const { log } = collector();
    const handler: FakeHandler = (method, path) => {
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/routines`) {
        return {
          status: 200,
          data: {
            items: [
              routineRow({
                id: "rtn_legacy",
                name: "Daily digest",
                presetKey: null,
              }),
            ],
          },
        };
      }
      throw new Error(`must not touch legacy rows: ${method} ${path}`);
    };

    await pruneDroppedPresetRoutines(fakeAPI(handler), [], TENANT_ID, log);
  });

  test("a concurrent prune 404 is already-retired, not a failure", async () => {
    const { lines, log } = collector();
    const handler: FakeHandler = (method, path) => {
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/routines`) {
        return {
          status: 200,
          data: {
            items: [
              routineRow({
                id: "rtn_digest",
                name: "Daily digest",
                presetKey: "workbench-digest",
              }),
            ],
          },
        };
      }
      if (
        method === "DELETE" &&
        path === `/api/tenants/${TENANT_ID}/routines/rtn_digest`
      ) {
        return { status: 404, data: { error: "not found" } };
      }
      throw new Error(`unexpected hub call: ${method} ${path}`);
    };

    await pruneDroppedPresetRoutines(fakeAPI(handler), [], TENANT_ID, log);

    expect(lines.join("\n")).toContain('routine "Daily digest" already retired');
  });

  test("a non-204 delete is a loud failure naming the routine", async () => {
    const { log } = collector();
    const handler: FakeHandler = (method, path) => {
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/routines`) {
        return {
          status: 200,
          data: {
            items: [
              routineRow({
                id: "rtn_digest",
                name: "Daily digest",
                presetKey: "workbench-digest",
              }),
            ],
          },
        };
      }
      if (
        method === "DELETE" &&
        path === `/api/tenants/${TENANT_ID}/routines/rtn_digest`
      ) {
        return { status: 500, data: { error: "boom" } };
      }
      return undefined;
    };

    expect(
      pruneDroppedPresetRoutines(fakeAPI(handler), [], TENANT_ID, log),
    ).rejects.toThrow(HubApiError);
  });
});
