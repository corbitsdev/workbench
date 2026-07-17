import { describe, expect, test } from "bun:test";
import {
  SUMMARY_AGENT_DEPLOY_DESCRIPTOR,
  SUMMARY_AGENT_DEPLOY_PROMPT,
  SUMMARY_AGENT_MODEL_CONFIG,
} from "./definition";

describe("summary agent definition", () => {
  test("is exported with a non-empty compaction-oriented system prompt", () => {
    expect(SUMMARY_AGENT_DEPLOY_PROMPT.length).toBeGreaterThan(0);
    expect(SUMMARY_AGENT_DEPLOY_PROMPT.toLowerCase()).toContain("recap");
    expect(SUMMARY_AGENT_DEPLOY_PROMPT.toLowerCase()).toContain("open");
    expect(SUMMARY_AGENT_DEPLOY_PROMPT.toLowerCase()).toContain(
      "relevant facts",
    );
  });

  test("instructs a tool-free, non-invented summary that replaces the conversation", () => {
    const prompt = SUMMARY_AGENT_DEPLOY_PROMPT.toLowerCase();
    expect(prompt).toContain("replace");
    expect(prompt).toContain("do not call tools");
    expect(prompt).toContain("invent");
  });

  test("is configured to the cheap fast model", () => {
    expect(SUMMARY_AGENT_MODEL_CONFIG.defaultModel).toBe("deepseek-v4-flash");
    expect(SUMMARY_AGENT_DEPLOY_DESCRIPTOR.modelConfig?.defaultModel).toBe(
      "deepseek-v4-flash",
    );
  });

  test("carries no tools — output must be a tool-free summary turn", () => {
    expect(SUMMARY_AGENT_DEPLOY_DESCRIPTOR.defaultTools).toHaveLength(0);
    expect(SUMMARY_AGENT_DEPLOY_DESCRIPTOR.requiredTools).toHaveLength(0);
  });
});
