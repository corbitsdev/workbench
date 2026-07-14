import { describe, expect, test } from "bun:test";
import { isUuid } from "../lib/uuid";
import { mintWorkflowRunId } from "./mint-workflow-run-id";

describe("mintWorkflowRunId", () => {
  test("returns an RFC-shaped UUID", () => {
    expect(isUuid(mintWorkflowRunId())).toBe(true);
  });
});
