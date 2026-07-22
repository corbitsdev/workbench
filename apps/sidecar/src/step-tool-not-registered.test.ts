import { describe, expect, test } from "bun:test";
import {
  StepToolNotRegisteredError,
  StepToolCredentialMissingError,
  StepToolFactoryAbsentError,
  assertStepToolAvailable,
  isStepToolInfrastructureFault,
} from "./step-tool-harness";

// GOAL B (CL-2503): a step that declares a tool which never loaded (the
// stale/missing package-registry tarball case) must fail with a clear, named,
// actionable error — not a generic step failure.
describe("assertStepToolAvailable", () => {
  test("passes silently when the declared tool loaded", () => {
    expect(() =>
      assertStepToolAvailable(
        "@workbench/tools-last30days/core:last30days_ground_queries",
        new Set([
          "@workbench/tools-last30days/core:last30days_ground_queries",
          "other_tool",
        ]),
      ),
    ).not.toThrow();
  });

  test("throws a named, actionable error naming the unresolved tool", () => {
    let thrown: unknown;
    try {
      assertStepToolAvailable(
        "@workbench/tools-last30days/core:last30days_ground_queries",
        new Set(["some_other_tool"]),
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StepToolNotRegisteredError);
    const error = thrown as StepToolNotRegisteredError;
    expect(error.toolName).toBe(
      "@workbench/tools-last30days/core:last30days_ground_queries",
    );
    expect(error.message).toContain(
      'tool "@workbench/tools-last30days/core:last30days_ground_queries" is not registered/available for this deployment',
    );
    // The loaded set is surfaced so an operator can see what DID link up.
    expect(error.message).toContain("some_other_tool");
    expect(error.loadedTools).toEqual(["some_other_tool"]);
    // An Error subclass carries a stack so the workflow-child's Sentry sink
    // captures it via captureException (GOAL A).
    expect(typeof error.stack).toBe("string");
  });

  test("reports 'none' when no tools loaded at all (stale tarball)", () => {
    expect(() =>
      assertStepToolAvailable("missing_tool", new Set<string>()),
    ).toThrow(/loaded tools: none/);
  });

  // CL-4196: a package that materialized but was dropped for a missing tenant
  // credential must fail with a credential-specific error naming the
  // provider, not the generic (and false) "not pinned" error.
  test("throws StepToolCredentialMissingError naming the provider when the tool's factory was credential-skipped", () => {
    let thrown: unknown;
    try {
      assertStepToolAvailable(
        "@workbench/tools-sumble/sumble:sumble_get_organization_list",
        new Set(["@workbench/tools-artifact/core:artifact_write"]),
        [
          {
            factoryId: "@workbench/tools-sumble/sumble",
            providerName: "sumble",
          },
        ],
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StepToolCredentialMissingError);
    const error = thrown as StepToolCredentialMissingError;
    expect(error.toolName).toBe(
      "@workbench/tools-sumble/sumble:sumble_get_organization_list",
    );
    expect(error.providerName).toBe("sumble");
    expect(error.message).toContain('provider "sumble"');
    expect(error.message).toContain("configure");
  });

  test("falls back to StepToolNotRegisteredError when the tool's factory was never credential-skipped", () => {
    expect(() =>
      assertStepToolAvailable(
        "@workbench/tools-other/other:other_tool",
        new Set<string>(),
        [
          {
            factoryId: "@workbench/tools-sumble/sumble",
            providerName: "sumble",
          },
        ],
      ),
    ).toThrow(StepToolNotRegisteredError);
  });
});

describe("isStepToolInfrastructureFault", () => {
  test("classifies StepToolNotRegisteredError as an infrastructure fault", () => {
    expect(
      isStepToolInfrastructureFault(new StepToolNotRegisteredError("t", [])),
    ).toBe(true);
  });

  test("classifies StepToolCredentialMissingError as an infrastructure fault", () => {
    expect(
      isStepToolInfrastructureFault(
        new StepToolCredentialMissingError("t", "sumble"),
      ),
    ).toBe(true);
  });

  test("classifies StepToolFactoryAbsentError as an infrastructure fault", () => {
    expect(
      isStepToolInfrastructureFault(
        new StepToolFactoryAbsentError("pkg", "addr"),
      ),
    ).toBe(true);
  });

  test("does not classify a plain Error (a genuine tool/data failure) as an infrastructure fault", () => {
    expect(isStepToolInfrastructureFault(new Error("boom"))).toBe(false);
  });
});
