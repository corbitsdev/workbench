import { describe, expect, it } from "bun:test";
import {
  LOOP_CREDENTIAL_REQUIREMENTS,
  LOOP_DEPLOY_PROMPT,
  LOOP_DEPLOY_DESCRIPTOR,
} from "./definition";
import { LLM_CREDENTIAL_NAME } from "../constants";

describe("loop agent definition", () => {
  it("requires a single tenant-owned openai-compatible LLM credential", () => {
    expect(LOOP_CREDENTIAL_REQUIREMENTS).toHaveLength(1);
    const requirement = LOOP_CREDENTIAL_REQUIREMENTS[0];
    expect(requirement?.providerName).toBe("openai-compatible");
    expect(requirement?.source).toBe("tenant");
    expect(requirement?.name).toBe(LLM_CREDENTIAL_NAME);
  });

  it("bakes a non-empty xml deploy prompt for the agent named Loop", () => {
    expect(LOOP_DEPLOY_PROMPT.length).toBeGreaterThan(0);
    expect(LOOP_DEPLOY_PROMPT).toContain(
      "Loop is a research and intelligence agent",
    );
    expect(LOOP_DEPLOY_PROMPT).toContain("<role>");
  });

  it("exposes a deploy descriptor wired to the baked prompt and credential provider", () => {
    expect(LOOP_DEPLOY_DESCRIPTOR.name).toBe("Loop");
    expect(LOOP_DEPLOY_DESCRIPTOR.systemPrompt).toBe(LOOP_DEPLOY_PROMPT);
    expect(LOOP_DEPLOY_DESCRIPTOR.credentialProviderNames).toEqual([
      "openai-compatible",
    ]);
  });

  it("can search and reply to inbound mail by default", () => {
    expect(LOOP_DEPLOY_DESCRIPTOR.defaultTools).toEqual([
      "mail_search",
      "mail_reply",
    ]);
    expect(LOOP_DEPLOY_DESCRIPTOR.requiredTools).toEqual([
      "mail_search",
      "mail_reply",
    ]);
  });
});
