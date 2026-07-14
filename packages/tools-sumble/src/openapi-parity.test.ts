import { describe, expect, it } from "bun:test";
import {
  SUMBLE_V9_OPERATION_COVERAGE,
  operationKey,
} from "./operation-coverage";
import { SUMBLE_TOOL_SPECS } from "./registry";

describe("Sumble v9 OpenAPI parity", () => {
  it("covers every documented v9 operation with at least one hub tool", () => {
    const covered = new Set(
      SUMBLE_V9_OPERATION_COVERAGE.map((op) =>
        operationKey(op.method, op.path),
      ),
    );
    expect(covered.size).toBe(SUMBLE_V9_OPERATION_COVERAGE.length);
    for (const op of SUMBLE_V9_OPERATION_COVERAGE) {
      expect(op.tools.length).toBeGreaterThan(0);
      for (const toolName of op.tools) {
        expect(
          SUMBLE_TOOL_SPECS.some((s) => s.definition.name === toolName),
        ).toBe(true);
      }
    }
  });

  it("registers a hub tool for each coverage entry", () => {
    const toolNames = new Set(SUMBLE_TOOL_SPECS.map((s) => s.definition.name));
    const referenced = new Set(
      SUMBLE_V9_OPERATION_COVERAGE.flatMap((op) => op.tools),
    );
    for (const name of referenced) {
      expect(toolNames.has(name)).toBe(true);
    }
  });
});
