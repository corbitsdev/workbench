import { describe, expect, test } from "bun:test";
import {
  INTERNAL_WRITE_EXCLUSIONS,
  approvalGatedWriteNames,
} from "./tool-side-effects";

// A representative slice of every `sideEffect: "write"` bare name the hub
// aggregates: external third-party writes that must gate, plus internal
// durable writes that must not.
const ALL_WRITE_BARE_NAMES = [
  "attio_update_task",
  "attio_create_note",
  "gamma_create_from_template",
  "gamma_duplicate_presentation",
  "vercel_deploy_static_file",
  "vercel_deploy_artifact",
  "memory_save",
  "write_artifact",
  "identity_set",
  "skill_draft",
  "dispatch_agent",
  "artifact_create",
  "artifact_write",
  "artifact_link_file",
  "workflow_start",
  "workflow_signal",
];

describe("approvalGatedWriteNames", () => {
  test("gates external writes as their LLM-safe names", () => {
    const gated = approvalGatedWriteNames(ALL_WRITE_BARE_NAMES);
    expect(gated.has("attio__update_task")).toBe(true);
    expect(gated.has("attio__create_note")).toBe(true);
    expect(gated.has("gamma__create_from_template")).toBe(true);
    expect(gated.has("gamma__duplicate_presentation")).toBe(true);
    expect(gated.has("vercel__deploy_static_file")).toBe(true);
    expect(gated.has("deploy-artifact__vercel_deploy_artifact")).toBe(true);
  });

  test("does not gate internal durable writes", () => {
    const gated = approvalGatedWriteNames(ALL_WRITE_BARE_NAMES);
    expect(gated.has("artifact__write")).toBe(false);
    expect(gated.has("artifact__create")).toBe(false);
    expect(gated.has("artifact__link_file")).toBe(false);
    expect(gated.has("artifact__memory_save")).toBe(false);
    expect(gated.has("dispatch__dispatch_agent")).toBe(false);
    expect(gated.has("skills__draft")).toBe(false);
    expect(gated.has("workflows__start")).toBe(false);
    expect(gated.has("workflows__signal")).toBe(false);
    // write_artifact / memory_save / identity_set are hub-backed on the
    // artifact/agents factories; none of their safe names should appear.
    expect([...gated].some((n) => n.endsWith("write_artifact"))).toBe(false);
    expect([...gated].some((n) => n.endsWith("memory_save"))).toBe(false);
    expect([...gated].some((n) => n.endsWith("identity_set"))).toBe(false);
  });

  test("only the six external writes survive the exclusion filter", () => {
    const gated = approvalGatedWriteNames(ALL_WRITE_BARE_NAMES);
    expect(gated.size).toBe(6);
  });

  test("never emits a bare name — every gated name is LLM-safe", () => {
    const gated = approvalGatedWriteNames(ALL_WRITE_BARE_NAMES);
    for (const name of gated) expect(name.includes("__")).toBe(true);
    expect(gated.has("attio_update_task")).toBe(false);
    expect(gated.has("vercel_deploy_static_file")).toBe(false);
  });

  test("INTERNAL_WRITE_EXCLUSIONS covers the internal write surface only", () => {
    for (const name of [
      "memory_save",
      "write_artifact",
      "identity_set",
      "skill_draft",
      "dispatch_agent",
      "artifact_create",
      "artifact_write",
      "artifact_link_file",
      "workflow_start",
      "workflow_signal",
    ]) {
      expect(INTERNAL_WRITE_EXCLUSIONS.has(name)).toBe(true);
    }
    expect(INTERNAL_WRITE_EXCLUSIONS.has("attio_update_task")).toBe(false);
    expect(INTERNAL_WRITE_EXCLUSIONS.has("vercel_deploy_artifact")).toBe(false);
  });
});
