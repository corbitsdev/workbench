import { describe, expect, test } from "bun:test";
import {
  APPROVAL_REQUIRED_BARE_NAMES,
  approvalGatedLlmToolNames,
  isApprovalRequiredBare,
} from "./tool-side-effects";
import { canonicalizeToolNames, toLlmToolName } from "./tool-names";

describe("approvalGatedLlmToolNames", () => {
  test("maps Vercel bare writes to the LLM-safe names the harness gate sees", () => {
    const gated = approvalGatedLlmToolNames();
    // factory `@workbench/tools-vercel/vercel` → vercel__deploy_static_file
    expect(gated.has("vercel__deploy_static_file")).toBe(true);
    // factory `@workbench/tools-vercel/deploy-artifact` keeps the full tool
    // segment (it does not start with deploy-artifact_)
    expect(gated.has("deploy-artifact__vercel_deploy_artifact")).toBe(true);
    // Bare names must NOT be the only match — the model never calls them.
    expect(gated.has("vercel_deploy_static_file")).toBe(false);
    expect(gated.has("vercel_deploy_artifact")).toBe(false);
    expect(gated.has("vercel__deploy_artifact")).toBe(false);
  });

  test("maps Attio write tools to LLM-safe names", () => {
    const gated = approvalGatedLlmToolNames();
    expect(gated.has("attio__update_task")).toBe(true);
    expect(gated.has("attio__create_note")).toBe(true);
    expect(gated.has("attio__query_records")).toBe(false);
  });

  test("maps Gamma write tools and leaves list tools ungated", () => {
    const gated = approvalGatedLlmToolNames();
    expect(gated.has("gamma__create_from_template")).toBe(true);
    expect(gated.has("gamma__duplicate_presentation")).toBe(true);
    expect(gated.has("gamma__list_themes")).toBe(false);
  });

  test("does not gate internal durable writes (memory / artifacts / dispatch)", () => {
    const gated = approvalGatedLlmToolNames();
    expect(gated.has("artifact__create")).toBe(false);
    expect(gated.has("artifact__write")).toBe(false);
    expect(gated.has("artifact__memory_save")).toBe(false);
    expect(gated.has("dispatch__dispatch_agent")).toBe(false);
    expect(gated.has("memory_save")).toBe(false);
  });

  test("every approval-required bare name is known to the package name table", () => {
    for (const bare of APPROVAL_REQUIRED_BARE_NAMES) {
      const canonical = canonicalizeToolNames([bare])[0];
      expect(canonical).toBeDefined();
      expect(canonical?.includes(":")).toBe(true);
      expect(toLlmToolName(canonical ?? bare).length).toBeGreaterThan(0);
    }
  });

  test("isApprovalRequiredBare matches the bare registry only", () => {
    expect(isApprovalRequiredBare("attio_update_task")).toBe(true);
    expect(isApprovalRequiredBare("attio_list_tasks")).toBe(false);
    expect(isApprovalRequiredBare("attio__update_task")).toBe(false);
    expect(isApprovalRequiredBare("memory_save")).toBe(false);
  });
});
