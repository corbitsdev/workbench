import { describe, expect, it } from "bun:test";
import {
  GERALT_CREDENTIAL_REQUIREMENTS,
  GERALT_DEPLOY_DESCRIPTOR,
  GERALT_TOOL_NAMES,
} from "./definition";
import { LLM_CREDENTIAL_NAME } from "../constants";

describe("geralt agent definition", () => {
  it("declares only the LLM credential as an inference source requirement", () => {
    expect(GERALT_CREDENTIAL_REQUIREMENTS).toHaveLength(1);
    const requirement = GERALT_CREDENTIAL_REQUIREMENTS[0];
    expect(requirement?.providerName).toBe("openai-compatible");
    expect(requirement?.source).toBe("tenant");
    expect(requirement?.name).toBe(LLM_CREDENTIAL_NAME);
  });

  it("does not declare the gamma tool credential as an inference source", () => {
    const providerNames = GERALT_CREDENTIAL_REQUIREMENTS.map(
      (r) => r.providerName,
    );
    expect(providerNames).not.toContain("gamma");
  });

  it("advertises gamma as a credential provider for onboarding", () => {
    expect(GERALT_DEPLOY_DESCRIPTOR.credentialProviderNames).toEqual([
      "openai-compatible",
      "gamma",
    ]);
  });

  it("defaultTools and requiredTools both derive from GERALT_TOOL_NAMES", () => {
    expect(GERALT_DEPLOY_DESCRIPTOR.defaultTools).toEqual([
      ...GERALT_TOOL_NAMES,
    ]);
    expect(GERALT_DEPLOY_DESCRIPTOR.requiredTools).toEqual([
      ...GERALT_TOOL_NAMES,
    ]);
  });

  it("includes all expected tool names", () => {
    const names: string[] = Array.from(GERALT_TOOL_NAMES);
    expect(names).toContain("gamma_list_templates");
    expect(names).toContain("gamma_list_themes");
    expect(names).toContain("gamma_create_from_template");
    expect(names).toContain("gamma_duplicate_presentation");
    expect(names).toContain("artifact_link_presentation");
    expect(names).toContain("artifact_find_by_title");
    expect(names).toContain("mail_search");
    expect(names).toContain("mail_reply");
    expect(names).toHaveLength(8);
  });

  it("has the correct label and name", () => {
    expect(GERALT_DEPLOY_DESCRIPTOR.label).toBe(
      "Geralt — Presentation Builder",
    );
    expect(GERALT_DEPLOY_DESCRIPTOR.name).toBe("Geralt");
  });
});
