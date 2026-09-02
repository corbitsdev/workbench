// The follow-latest rule, proven without a database: `pickLaunchableDefinition`
// is the pure half of `resolveLaunchableDefinition`, and these are the
// orderings that matter — the newest FROZEN deployment wins even when a
// newer unfrozen redeploy exists, and each rejection reason is the most
// specific one the rows support.
import { describe, expect, test } from "bun:test";

import {
  pickLaunchableDefinition,
  routineTargetRejection,
  type LaunchableDefinitionCandidate,
} from "./target";

const TENANT = "tnt_1";

function candidate(
  overrides: Partial<LaunchableDefinitionCandidate> & { id: string },
): LaunchableDefinitionCandidate {
  return {
    tenantId: TENANT,
    status: "deployed",
    approvedWireHash: `hash_${overrides.id}`,
    grantSnapshot: { grants: [] },
    wireProjection: { steps: [] },
    createdAt: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  };
}

describe("pickLaunchableDefinition", () => {
  test("the newest frozen, deployed row wins regardless of input order", () => {
    const older = candidate({
      id: "wfd_v1",
      createdAt: new Date("2026-08-01T00:00:00Z"),
    });
    const newer = candidate({
      id: "wfd_v2",
      createdAt: new Date("2026-08-15T00:00:00Z"),
    });
    expect(pickLaunchableDefinition([older, newer], TENANT)).toEqual({
      ok: true,
      definitionId: "wfd_v2",
      wireHash: "hash_wfd_v2",
    });
    expect(pickLaunchableDefinition([newer, older], TENANT)).toEqual({
      ok: true,
      definitionId: "wfd_v2",
      wireHash: "hash_wfd_v2",
    });
  });

  test("a newer redeploy that is not yet frozen is skipped in favour of the newest frozen one", () => {
    const frozen = candidate({
      id: "wfd_v1",
      createdAt: new Date("2026-08-01T00:00:00Z"),
    });
    const unfrozenNewer = candidate({
      id: "wfd_v2",
      createdAt: new Date("2026-08-15T00:00:00Z"),
      approvedWireHash: null,
      grantSnapshot: null,
      wireProjection: null,
    });
    const partiallyFrozenNewer = candidate({
      id: "wfd_v3",
      createdAt: new Date("2026-08-20T00:00:00Z"),
      wireProjection: null,
    });
    const picked = pickLaunchableDefinition(
      [unfrozenNewer, frozen, partiallyFrozenNewer],
      TENANT,
    );
    expect(picked).toEqual({
      ok: true,
      definitionId: "wfd_v1",
      wireHash: "hash_wfd_v1",
    });
  });

  test("a stopped row is never picked even when it is newest and frozen", () => {
    const live = candidate({
      id: "wfd_v1",
      createdAt: new Date("2026-08-01T00:00:00Z"),
    });
    const stopped = candidate({
      id: "wfd_v2",
      status: "stopped",
      createdAt: new Date("2026-08-15T00:00:00Z"),
    });
    expect(pickLaunchableDefinition([stopped, live], TENANT)).toEqual({
      ok: true,
      definitionId: "wfd_v1",
      wireHash: "hash_wfd_v1",
    });
  });

  test("rejection reasons are the most specific the rows support", () => {
    expect(pickLaunchableDefinition([], TENANT)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(
      pickLaunchableDefinition(
        [candidate({ id: "wfd_theirs", tenantId: "tnt_other" })],
        TENANT,
      ),
    ).toEqual({ ok: false, reason: "cross_tenant" });
    expect(
      pickLaunchableDefinition(
        [
          candidate({ id: "wfd_stopped", status: "stopped" }),
          candidate({ id: "wfd_theirs", tenantId: "tnt_other" }),
        ],
        TENANT,
      ),
    ).toEqual({ ok: false, reason: "not_deployed" });
    expect(
      pickLaunchableDefinition(
        [
          candidate({ id: "wfd_pending", approvedWireHash: null }),
          candidate({ id: "wfd_stopped", status: "stopped" }),
        ],
        TENANT,
      ),
    ).toEqual({ ok: false, reason: "unfrozen" });
  });
});

describe("routineTargetRejection", () => {
  test("a cross-tenant asset is reported exactly like a missing one", () => {
    expect(routineTargetRejection("cross_tenant")).toEqual(
      routineTargetRejection("not_found"),
    );
    expect(routineTargetRejection("not_found").status).toBe(404);
  });

  test("every reason carries a distinct code a UI or Myra can branch on", () => {
    const codes = new Set(
      (["not_found", "unfrozen", "not_deployed"] as const).map(
        (reason) => routineTargetRejection(reason).code,
      ),
    );
    expect(codes.size).toBe(3);
  });
});
