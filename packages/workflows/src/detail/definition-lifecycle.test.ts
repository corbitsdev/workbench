import { describe, expect, test } from "bun:test";
import {
  deriveWorkflowLifecycle,
  type DefinitionLifecycleRow,
} from "./definition-lifecycle";

function row(patch: Partial<DefinitionLifecycleRow>): DefinitionLifecycleRow {
  return {
    id: "wfd_1",
    wireHash: "hash_1",
    approvedWireHash: "hash_1",
    grantSnapshot: { perStep: [], grantRequirements: [] },
    wireProjection: { stepOrder: [], steps: {} },
    status: "deployed",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

describe("deriveWorkflowLifecycle", () => {
  test("no definition rows and no deploy attempt is source-only", () => {
    const result = deriveWorkflowLifecycle([], false);
    expect(result).toEqual({
      lifecycle: "source-only",
      currentDefinitionId: null,
      wireHash: null,
    });
  });

  test("no definition rows but a deploy attempt on record is build-failed", () => {
    const result = deriveWorkflowLifecycle([], true);
    expect(result).toEqual({
      lifecycle: "build-failed",
      currentDefinitionId: null,
      wireHash: null,
    });
  });

  test("newest row lacking an approved hash is pending-approval", () => {
    const result = deriveWorkflowLifecycle(
      [row({ id: "wfd_2", approvedWireHash: null })],
      true,
    );
    expect(result.lifecycle).toBe("pending-approval");
    expect(result.currentDefinitionId).toBe("wfd_2");
  });

  test("newest row approved and deployed is deployed", () => {
    const result = deriveWorkflowLifecycle([row({ id: "wfd_3" })], true);
    expect(result).toEqual({
      lifecycle: "deployed",
      currentDefinitionId: "wfd_3",
      wireHash: "hash_1",
    });
  });

  test("newest row approved but stopped is superseded", () => {
    const result = deriveWorkflowLifecycle(
      [row({ id: "wfd_4", status: "stopped" })],
      true,
    );
    expect(result.lifecycle).toBe("superseded");
  });

  test("picks the newest of several rows by createdAt", () => {
    const older = row({
      id: "wfd_old",
      status: "stopped",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const newer = row({
      id: "wfd_new",
      status: "deployed",
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    const result = deriveWorkflowLifecycle([older, newer], true);
    expect(result.lifecycle).toBe("deployed");
    expect(result.currentDefinitionId).toBe("wfd_new");
  });
});
