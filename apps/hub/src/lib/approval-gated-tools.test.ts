import { describe, expect, test } from "bun:test";
import {
  APPROVAL_GATED_TOOL_NAMES,
  NATIVE_APPROVAL_GATED_TOOL_NAMES,
  approvalGatedWriteNames,
} from "@workbench/agents";
import { writeToolNamesFromEntries } from "@workbench/tool-credentials/factory";
import { VERCEL_HUB_TOOLS } from "@workbench/tools-vercel";
import { VERCEL_DEPLOY_ARTIFACT_HUB_TOOLS } from "../tools/vercel-deploy-artifact";
import { KNOWN_TOOLS } from "./tool-registry";

/**
 * Drift guard: `APPROVAL_GATED_TOOL_NAMES` is derived in `@workbench/agents`
 * from committed manifest `sideEffects` (plus hub-only tools and native mail).
 * This test recomputes the same set from `KNOWN_TOOLS` and asserts equality.
 */
function deriveGatedSet(): Set<string> {
  const writeBareNames = new Set([
    ...writeToolNamesFromEntries(KNOWN_TOOLS),
    ...writeToolNamesFromEntries(VERCEL_HUB_TOOLS),
    ...writeToolNamesFromEntries(VERCEL_DEPLOY_ARTIFACT_HUB_TOOLS),
  ]);
  return new Set([
    ...approvalGatedWriteNames([...writeBareNames]),
    ...NATIVE_APPROVAL_GATED_TOOL_NAMES,
  ]);
}

describe("APPROVAL_GATED_TOOL_NAMES drift guard", () => {
  test("manifest-derived gated set matches KNOWN_TOOLS sideEffect writes", () => {
    expect(new Set(APPROVAL_GATED_TOOL_NAMES)).toEqual(deriveGatedSet());
  });

  test("contains the external writes as LLM-safe names, including notion_create_page", () => {
    for (const name of [
      "attio__update_task",
      "attio__create_note",
      "gamma__create_from_template",
      "gamma__duplicate_presentation",
      "vercel__deploy_static_file",
      "deploy-artifact__vercel_deploy_artifact",
      // A package that merged independently: gated purely by its
      // `sideEffect: "write"` classification, no hand-list needed.
      "notion__create_page",
    ]) {
      expect(APPROVAL_GATED_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  test("contains none of the internal durable writes", () => {
    for (const name of [
      "artifact__write",
      "artifact__create",
      "dispatch__dispatch_agent",
      "skills__draft",
      "workflows__start",
      "workflows__signal",
    ]) {
      expect(APPROVAL_GATED_TOOL_NAMES.has(name)).toBe(false);
    }
    // hub-backed internal writes ride the artifact/agents factories
    expect(
      [...APPROVAL_GATED_TOOL_NAMES].some((n) => n.endsWith("memory_save")),
    ).toBe(false);
    expect(
      [...APPROVAL_GATED_TOOL_NAMES].some((n) => n.endsWith("write_artifact")),
    ).toBe(false);
    expect(
      [...APPROVAL_GATED_TOOL_NAMES].some((n) => n.endsWith("identity_set")),
    ).toBe(false);
  });

  test("every gated name is LLM-safe (no bare colon-form or raw name)", () => {
    for (const name of APPROVAL_GATED_TOOL_NAMES) {
      expect(name.includes(":")).toBe(false);
      // Native local-runner tools (mail_send) pass through toLlmToolName
      // unchanged — they carry no `<factoryId>:` prefix to begin with — so
      // only the tool-package-derived names carry the `__` join.
      if (!NATIVE_APPROVAL_GATED_TOOL_NAMES.has(name)) {
        expect(name.includes("__")).toBe(true);
      }
    }
  });

  test("gates mail_send as a hand-listed native write", () => {
    expect(APPROVAL_GATED_TOOL_NAMES.has("mail_send")).toBe(true);
    expect(NATIVE_APPROVAL_GATED_TOOL_NAMES.has("mail_send")).toBe(true);
  });
});
