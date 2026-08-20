import { describe, expect, test } from "bun:test";

import type { GrantRule } from "@intx/types/authz";

import {
  createToolAllowanceRegistry,
  evaluateToolAllowance,
  withGrantAllowance,
  type ToolAllowance,
} from "./allowance";

const TENANT = "tenant_1";

function repoGrant(overrides?: Partial<GrantRule>): GrantRule {
  return {
    id: "grant_repo",
    resource: "repo:acme/rocket",
    action: "read",
    effect: "allow",
    origin: "system",
    conditions: null,
    expiresAt: null,
    roleId: "role_member",
    principalId: null,
    ...overrides,
  };
}

const readDiffAllowance: ToolAllowance = {
  tool: "read_diff",
  grantAction: "read",
  classify: (_tenantId, args) =>
    Promise.resolve(
      typeof args["repo"] === "string"
        ? { readOnly: true, resource: `repo:${args["repo"]}` }
        : { readOnly: false },
    ),
};

const mergeAllowance: ToolAllowance = {
  tool: "merge_pr",
  grantAction: "read",
  classify: () => Promise.resolve({ readOnly: false }),
};

const registry = createToolAllowanceRegistry([
  readDiffAllowance,
  mergeAllowance,
]);

describe("createToolAllowanceRegistry", () => {
  test("rejects duplicate tool annotations", () => {
    expect(() =>
      createToolAllowanceRegistry([readDiffAllowance, readDiffAllowance]),
    ).toThrow(/duplicate allowance/);
  });
});

describe("evaluateToolAllowance", () => {
  test("read-only call with a covering grant rides, attributed to the grant", async () => {
    const decision = await evaluateToolAllowance({
      registry,
      tenantId: TENANT,
      toolName: "read_diff",
      toolArguments: { repo: "acme/rocket" },
      grants: [repoGrant()],
    });
    expect(decision).toEqual({
      outcome: "ride",
      resource: "repo:acme/rocket",
      grantId: "grant_repo",
    });
  });

  test("read-only call without a covering grant parks", async () => {
    const decision = await evaluateToolAllowance({
      registry,
      tenantId: TENANT,
      toolName: "read_diff",
      toolArguments: { repo: "acme/other" },
      grants: [repoGrant()],
    });
    expect(decision).toEqual({ outcome: "park", reason: "no_covering_grant" });
  });

  test("write call parks even when the resource grant exists", async () => {
    const decision = await evaluateToolAllowance({
      registry,
      tenantId: TENANT,
      toolName: "merge_pr",
      toolArguments: { repo: "acme/rocket" },
      grants: [repoGrant()],
    });
    expect(decision).toEqual({ outcome: "park", reason: "not_read_only" });
  });

  test("unannotated tool parks regardless of grants", async () => {
    const decision = await evaluateToolAllowance({
      registry,
      tenantId: TENANT,
      toolName: "push_branch",
      toolArguments: {},
      grants: [repoGrant()],
    });
    expect(decision).toEqual({ outcome: "park", reason: "unclassified" });
  });

  test("a deny grant on the resource never rides", async () => {
    const decision = await evaluateToolAllowance({
      registry,
      tenantId: TENANT,
      toolName: "read_diff",
      toolArguments: { repo: "acme/rocket" },
      grants: [repoGrant(), repoGrant({ id: "grant_deny", effect: "deny" })],
    });
    expect(decision).toEqual({ outcome: "park", reason: "no_covering_grant" });
  });

  test("a throwing classifier fails closed", async () => {
    const throwing = createToolAllowanceRegistry([
      {
        tool: "read_diff",
        grantAction: "read",
        classify: () => Promise.reject(new Error("server unreachable")),
      },
    ]);
    const decision = await evaluateToolAllowance({
      registry: throwing,
      tenantId: TENANT,
      toolName: "read_diff",
      toolArguments: { repo: "acme/rocket" },
      grants: [repoGrant()],
    });
    expect(decision).toEqual({
      outcome: "park",
      reason: "classification_failed",
    });
  });
});

describe("withGrantAllowance", () => {
  type Registered = Parameters<ReturnType<typeof withGrantAllowance>>[0];

  function gateHarness(overrides?: {
    grants?: GrantRule[];
    autoApproveResult?: boolean;
  }) {
    const calls = {
      base: [] as Registered[],
      autoApprove: [] as {
        approvalId: string;
        tenantId: string;
        resource: string;
        grantId: string;
      }[],
      log: [] as string[],
    };
    const gate = withGrantAllowance(
      async (args: Registered) => {
        calls.base.push(args);
      },
      {
        registry,
        findRegisteredApproval: (correlationId) =>
          Promise.resolve({
            approvalId: `apr_${correlationId}`,
            tenantId: TENANT,
          }),
        listTenantGrants: () =>
          Promise.resolve(overrides?.grants ?? [repoGrant()]),
        autoApprove: (args) => {
          calls.autoApprove.push(args);
          return Promise.resolve(overrides?.autoApproveResult ?? true);
        },
        log: (line) => calls.log.push(line),
      },
    );
    return { gate, calls };
  }

  test("read-only call with covering grant auto-approves after registration", async () => {
    const { gate, calls } = gateHarness();
    await gate({
      correlationId: "c1",
      approvalSnapshot: {
        name: "read_diff",
        arguments: { repo: "acme/rocket" },
      },
    });
    expect(calls.base).toHaveLength(1);
    expect(calls.autoApprove).toEqual([
      {
        approvalId: "apr_c1",
        tenantId: TENANT,
        resource: "repo:acme/rocket",
        grantId: "grant_repo",
      },
    ]);
    expect(calls.log[0]).toContain("auto-approved");
  });

  test("read-only call without covering grant stays parked", async () => {
    const { gate, calls } = gateHarness({ grants: [] });
    await gate({
      correlationId: "c2",
      approvalSnapshot: {
        name: "read_diff",
        arguments: { repo: "acme/rocket" },
      },
    });
    expect(calls.base).toHaveLength(1);
    expect(calls.autoApprove).toHaveLength(0);
    expect(calls.log[0]).toContain("parked (no_covering_grant)");
  });

  test("write call with grant stays parked", async () => {
    const { gate, calls } = gateHarness();
    await gate({
      correlationId: "c3",
      approvalSnapshot: {
        name: "merge_pr",
        arguments: { repo: "acme/rocket" },
      },
    });
    expect(calls.autoApprove).toHaveLength(0);
    expect(calls.log[0]).toContain("parked (not_read_only)");
  });

  test("unannotated tool takes the fast path: registration only", async () => {
    const { gate, calls } = gateHarness();
    await gate({
      correlationId: "c4",
      approvalSnapshot: { name: "push_branch", arguments: {} },
    });
    expect(calls.base).toHaveLength(1);
    expect(calls.autoApprove).toHaveLength(0);
    expect(calls.log).toHaveLength(0);
  });

  test("an allowance failure never breaks registration", async () => {
    const gate = withGrantAllowance(async () => {}, {
      registry,
      findRegisteredApproval: () => Promise.reject(new Error("db down")),
      listTenantGrants: () => Promise.resolve([]),
      autoApprove: () => Promise.resolve(true),
      log: () => {},
    });
    await expect(
      gate({
        correlationId: "c5",
        approvalSnapshot: { name: "read_diff", arguments: {} },
      }),
    ).resolves.toBeUndefined();
  });
});
