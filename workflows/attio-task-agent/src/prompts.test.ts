import { describe, expect, test } from "bun:test";
import { attioTaskArtifactKinds } from "@workbench/shared";
import { ARTIFACT_KIND_GUIDANCE, buildKindSystemPrompt } from "./prompts";

describe("per-kind generation prompts", () => {
  test("every artifact kind has a dedicated guidance block", () => {
    for (const kind of attioTaskArtifactKinds) {
      expect(ARTIFACT_KIND_GUIDANCE[kind]?.length).toBeGreaterThan(0);
    }
  });

  test("a kind's prompt carries ONLY its own guidance, not other kinds'", () => {
    // linkedin-post requires anonymization; cold-email is peer outreach. Each
    // prompt must be isolated — no cross-kind bleed — which is the whole point
    // of routing each kind to its own step.
    const linkedin = buildKindSystemPrompt("linkedin-post");
    expect(linkedin).toContain("ANONYMIZED");
    expect(linkedin).not.toContain("cold outreach");

    const cold = buildKindSystemPrompt("cold-email");
    expect(cold).toContain("cold outreach");
    expect(cold).not.toContain("ANONYMIZED");
  });

  test("the prompt pins the output kind so the model can't drift", () => {
    expect(buildKindSystemPrompt("blog")).toContain('"kind": "blog"');
  });
});
