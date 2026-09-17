// The needs-list manifest is the client's portable desired state: one
// user's primary tenant, the Myra agent running at top level, and every
// workbench sub-tenant with its members — plus the client-kept list of
// workbench tenant ids it created. These tests pin the builder, the
// arktype boundary, and the created-ids store.

import { describe, expect, test } from "bun:test";
import { type } from "arktype";

import {
  buildNeedsList,
  loadCreatedWorkbenchTenantIds,
  NeedsListSchema,
  parseNeedsList,
  recordCreatedWorkbenchTenantId,
  type NeedsListInput,
} from "./needs-list";

const input: NeedsListInput = {
  user: { id: "usr_1", email: "ada@example.com" },
  primaryTenant: { slug: "ada", name: "Ada" },
  myraDefinitionRefId: "assistant",
  workbenches: [
    {
      slug: "ada-atlas",
      name: "Atlas",
      members: [{ refId: "usr_2", email: "bea@example.com", role: "member" }],
    },
  ],
  shares: [{ workbenchSlug: "ada-atlas", email: "cyd@example.com" }],
  createdWorkbenchTenantIds: ["tnt_atlas"],
};

describe("buildNeedsList", () => {
  test("builds the full desired state for one user", () => {
    const manifest = buildNeedsList(input);
    expect(manifest.version).toBe(1);
    expect(manifest.primaryTenant).toEqual({ slug: "ada", name: "Ada" });
    expect(manifest.myra).toEqual({
      definitionRefId: "assistant",
      scope: "top-level",
      want: "running",
    });
    expect(manifest.workbenches).toHaveLength(1);
    expect(manifest.workbenches[0]?.parentSlug).toBe("ada");
    expect(manifest.workbenches[0]?.members[0]).toMatchObject({
      refId: "usr_2",
      kind: "user",
      status: "active",
      roles: ["member"],
    });
    expect(manifest.shares).toEqual([
      { workbenchSlug: "ada-atlas", email: "cyd@example.com" },
    ]);
    expect(manifest.createdWorkbenchTenantIds).toEqual(["tnt_atlas"]);
  });

  test("defaults the created-ids list to empty when the client is new", () => {
    const { createdWorkbenchTenantIds: _omitted, ...fresh } = input;
    const manifest = buildNeedsList(fresh);
    expect(manifest.createdWorkbenchTenantIds).toEqual([]);
  });

  test("the built manifest parses cleanly at the arktype boundary", () => {
    const parsed = parseNeedsList(buildNeedsList(input));
    expect(parsed instanceof type.errors).toBe(false);
  });
});

describe("parseNeedsList", () => {
  test("rejects a manifest missing the Myra refId", () => {
    const bad = { ...buildNeedsList(input), myra: {} };
    expect(parseNeedsList(bad) instanceof type.errors).toBe(true);
  });

  test("rejects an unknown manifest version", () => {
    const bad = { ...buildNeedsList(input), version: 99 };
    expect(parseNeedsList(bad) instanceof type.errors).toBe(true);
  });

  test("exposes the schema for hub-shaped reads to validate against", () => {
    expect(NeedsListSchema).toBeDefined();
  });
});

describe("created workbench tenant ids store", () => {
  function memoryStorage(initial: Record<string, string> = {}) {
    const rows = new Map(Object.entries(initial));
    return {
      getItem: (key: string) => rows.get(key) ?? null,
      setItem: (key: string, value: string) => {
        rows.set(key, value);
      },
    };
  }

  test("loads empty when the client never created a workbench", () => {
    expect(loadCreatedWorkbenchTenantIds(memoryStorage())).toEqual([]);
  });

  test("records ids without duplicating or dropping existing ones", () => {
    const storage = memoryStorage();
    recordCreatedWorkbenchTenantId(storage, "tnt_a");
    recordCreatedWorkbenchTenantId(storage, "tnt_b");
    recordCreatedWorkbenchTenantId(storage, "tnt_a");
    expect(loadCreatedWorkbenchTenantIds(storage)).toEqual(["tnt_a", "tnt_b"]);
  });

  test("treats a corrupt row as empty rather than throwing", () => {
    const storage = memoryStorage({
      "workbench.needs-list.created-tenant-ids": "not-json{{{",
    });
    expect(loadCreatedWorkbenchTenantIds(storage)).toEqual([]);
  });
});
