// `principalLabel`'s one job: never hand back a raw refId/address as the
// label a person reads, while leaving an already-humane display name alone.

import { describe, expect, test } from "bun:test";

import {
  PRINCIPAL_KIND_LABEL,
  PRINCIPAL_KIND_ORDER,
  principalLabel,
} from "../src/identity";

describe("principalLabel", () => {
  test("passes through an already-humane display name unchanged", () => {
    const result = principalLabel("Ada Lovelace");
    expect(result.label).toBe("Ada Lovelace");
    expect(result.raw).toBeNull();
  });

  test("derives a humane label from a raw agent refId and keeps the raw value", () => {
    const result = principalLabel("agt_research-assistant");
    expect(result.label).toBe("Research Assistant");
    expect(result.raw).toBe("agt_research-assistant");
  });

  test("derives a humane label from an address-shaped refId", () => {
    const result = principalLabel("agent://tenant-1/billing-bot@hub.local");
    expect(result.raw).toBe("agent://tenant-1/billing-bot@hub.local");
    expect(result.label).not.toContain("://");
    expect(result.label.length).toBeGreaterThan(0);
  });

  test("falls back to a plain label when nothing recognizable survives", () => {
    const result = principalLabel("agt_------");
    expect(result.label).toBe("Unnamed agent");
  });

  // CL-6075: a workflow principal's vendor-formatted display name is
  // `Workflow (<runId>@<slug>.localhost)` — the derivation strips the
  // scheme/host down to the last segment, which drags the wrapper's
  // trailing ")" along for the ride unless parens are stripped too.
  test("strips a trailing paren from a workflow principal's wrapped address", () => {
    const result = principalLabel(
      "Workflow (run_9f3a7c2e@alice-0ufqkxuy.localhost)",
    );
    expect(result.label).not.toContain("(");
    expect(result.label).not.toContain(")");
    expect(result.label).toBe("Alice 0ufqkxuy Localhost");
  });
});

// CL-6077: a principal picker that shows only a name, never its kind, is
// kind-blind — a workflow's machine principal can read identically to a
// person's account. Every picker groups or annotates by this shared label.
describe("PRINCIPAL_KIND_LABEL", () => {
  test("covers every kind in PRINCIPAL_KIND_ORDER with a distinct, honest label", () => {
    expect(PRINCIPAL_KIND_ORDER).toEqual(["user", "agent", "workflow"]);
    const labels = PRINCIPAL_KIND_ORDER.map(
      (kind) => PRINCIPAL_KIND_LABEL[kind],
    );
    expect(labels).toHaveLength(PRINCIPAL_KIND_ORDER.length);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual(["Person", "Agent", "Workflow"]);
    expect(labels).not.toEqual([...PRINCIPAL_KIND_ORDER]);
  });
});
