import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import {
  GtmScriptsBriefsArtifactLineageSchema,
  GtmScriptsBriefsIntakePayloadSchema,
} from "./gtm-scripts-briefs";

describe("GTM scripts and briefs contracts", () => {
  test("accepts the research-backed dock intake form contract", () => {
    const result = GtmScriptsBriefsIntakePayloadSchema({
      topic: "AI agent launches for revenue teams",
      days: 30,
      audience: "VP Sales",
      objective: "Start informed sales conversations.",
    });
    expect(result instanceof type.errors).toBe(false);
  });

  test("rejects missing topics and invalid research windows", () => {
    expect(
      GtmScriptsBriefsIntakePayloadSchema({
        topic: " ",
        days: 0,
      }) instanceof type.errors,
    ).toBe(true);
  });

  test("keeps persisted lineage aligned with the research-backed artifact", () => {
    const result = GtmScriptsBriefsArtifactLineageSchema({
      workflowKind: "gtm-scripts-briefs",
      topic: "AI agent launches for revenue teams",
      days: 30,
      audience: "VP Sales",
      objective: "Start informed sales conversations.",
      artifactKind: "long-form-script-package",
    });
    expect(result instanceof type.errors).toBe(false);
  });
});
