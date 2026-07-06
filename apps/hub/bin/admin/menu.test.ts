import { describe, it, expect } from "bun:test";
import { createClient } from "@workbench/openapi-arktype";
import {
  extractItems,
  findListOperation,
  groupByTag,
  itemLabel,
  operationInputs,
  referenceTagFor,
} from "./menu";
import type { OperationSummary } from "./client";

const SPEC = {
  openapi: "3.1.0",
  info: { title: "T", version: "1" },
  paths: {
    "/workflows/deploy": {
      post: {
        tags: ["Workflows"],
        parameters: [
          {
            name: "tenant",
            in: "query",
            required: false,
            description: "target slug",
            schema: { type: "string" },
          },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  id: { type: "string", description: "workflow id" },
                  steps: { type: "object" },
                },
                required: ["id"],
              },
            },
          },
        },
        responses: { "200": { description: "ok" } },
      },
    },
    "/members": {
      get: { tags: ["Members"], responses: { "200": { description: "ok" } } },
    },
    "/things/{id}": {
      delete: {
        tags: ["Members"],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: { "204": { description: "ok" } },
      },
    },
  },
};

async function loadSpec() {
  return createClient({ spec: SPEC });
}

describe("groupByTag", () => {
  it("groups operations by tag, sorted by tag name", () => {
    const ops: OperationSummary[] = [
      { tag: "Workflows", method: "post", path: "/workflows/deploy" },
      { tag: "Members", method: "get", path: "/members" },
      { tag: "Members", method: "delete", path: "/things/{id}" },
    ];
    const groups = groupByTag(ops);
    expect(groups.map((g) => g.tag)).toEqual(["Members", "Workflows"]);
    expect(groups[0]?.operations).toHaveLength(2);
    expect(groups[1]?.operations).toHaveLength(1);
  });
});

describe("operationInputs", () => {
  it("derives query param + required/optional body fields for a POST", async () => {
    const spec = await loadSpec();
    const inputs = operationInputs(spec, "post", "/workflows/deploy");

    expect(inputs).toEqual([
      {
        name: "tenant",
        kind: "query",
        required: false,
        description: "target slug",
        valueType: "string",
      },
      {
        name: "id",
        kind: "body",
        required: true,
        description: "workflow id",
        valueType: "string",
      },
      { name: "steps", kind: "body", required: false, valueType: "object" },
    ]);
  });

  it("derives a required path param for a DELETE", async () => {
    const spec = await loadSpec();
    const inputs = operationInputs(spec, "delete", "/things/{id}");
    expect(inputs).toEqual([
      { name: "id", kind: "path", required: true, valueType: "string" },
    ]);
  });

  it("returns no inputs for a parameterless GET", async () => {
    const spec = await loadSpec();
    expect(operationInputs(spec, "get", "/members")).toEqual([]);
  });

  it("surfaces enum values and reference tags from the spec", async () => {
    const spec = await createClient({
      spec: {
        openapi: "3.1.0",
        info: { title: "T", version: "1" },
        paths: {
          "/c": {
            post: {
              tags: ["Credentials"],
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        type: {
                          type: "string",
                          enum: ["api_key", "oauth_token"],
                        },
                        providerId: { type: "string" },
                      },
                      required: ["type", "providerId"],
                    },
                  },
                },
              },
              responses: { "200": { description: "ok" } },
            },
          },
        },
      },
    });
    const inputs = operationInputs(spec, "post", "/c");
    const byName = Object.fromEntries(inputs.map((i) => [i.name, i]));
    expect(byName["type"]?.enumValues).toEqual(["api_key", "oauth_token"]);
    expect(byName["providerId"]?.reference).toBe("Providers");
  });
});

describe("referenceTagFor", () => {
  it("maps known foreign-key id fields to their resource tag", () => {
    expect(referenceTagFor("principalId")).toBe("Principals");
    expect(referenceTagFor("credentialId")).toBe("Credentials");
  });

  it("returns undefined for unknown / non-reference fields", () => {
    expect(referenceTagFor("name")).toBeUndefined();
    expect(referenceTagFor("id")).toBeUndefined();
  });
});

describe("findListOperation", () => {
  const ops: OperationSummary[] = [
    {
      tag: "Providers",
      method: "post",
      path: "/api/tenants/{tenantId}/providers",
    },
    {
      tag: "Providers",
      method: "get",
      path: "/api/tenants/{tenantId}/providers",
    },
    {
      tag: "Providers",
      method: "get",
      path: "/api/tenants/{tenantId}/providers/{providerId}",
    },
  ];

  it("picks the collection GET (fewest path params)", () => {
    expect(findListOperation(ops, "Providers")?.path).toBe(
      "/api/tenants/{tenantId}/providers",
    );
  });

  it("returns undefined when the tag has no GET", () => {
    expect(
      findListOperation([{ tag: "X", method: "post", path: "/x" }], "X"),
    ).toBeUndefined();
  });

  it("prefers the shorter path when two GETs tie on path-param count", () => {
    const tieOps: OperationSummary[] = [
      { tag: "Workflows", method: "get", path: "/workflow-exec/credentials" },
      { tag: "Workflows", method: "get", path: "/workflow-runs" },
    ];
    expect(findListOperation(tieOps, "Workflows")?.path).toBe("/workflow-runs");
  });
});

describe("extractItems", () => {
  it("handles a paginated { data, nextCursor } envelope", () => {
    expect(extractItems({ data: [1, 2], nextCursor: "c1" })).toEqual({
      items: [1, 2],
      nextCursor: "c1",
    });
  });

  it("handles a bare array and a cursorless envelope", () => {
    expect(extractItems([1, 2])).toEqual({ items: [1, 2] });
    expect(extractItems({ data: [9] })).toEqual({ items: [9] });
  });
});

describe("itemLabel", () => {
  it("prefers a human name and appends the id", () => {
    expect(itemLabel({ id: "crd_1", name: "Myra LLM" })).toEqual({
      label: "Myra LLM [crd_1]",
      id: "crd_1",
    });
  });

  it("falls back to email then to the bare id", () => {
    expect(itemLabel({ id: "p1", email: "a@b.com" }).label).toBe(
      "a@b.com [p1]",
    );
    expect(itemLabel({ id: "only-id" })).toEqual({
      label: "only-id",
      id: "only-id",
    });
  });

  it("uses deploymentId as id when id is absent (workflow deployments list)", () => {
    const result = itemLabel({
      deploymentId: "ses_abc123",
      kind: "ab-compare-hitl",
      status: "completed",
      createdAt: "2026-06-22T10:00:00Z",
    });
    expect(result.id).toBe("ses_abc123");
    expect(result.label).toContain("ab-compare-hitl");
    expect(result.label).toContain("ses_abc123");
  });

  it("uses runId as id when id and deploymentId are absent", () => {
    const result = itemLabel({ runId: "wfr_xyz", kind: "smoke-test" });
    expect(result.id).toBe("wfr_xyz");
  });
});
