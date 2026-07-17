import { describe, it, expect } from "bun:test";
import {
  INVOKE_TEMPLATE_KEY,
  withInvokeSessionMarker,
  isInvokeSessionPrompt,
  isPersonalAgentDefinitionName,
} from "./invoke-policy";
import { stripSeedMarker } from "../core/seed-files";
import {
  PERSONAL_AGENT_NAME,
  PERSONAL_AGENT_TRIAGE_NAME,
} from "../core/definition";

describe("invoke-policy", () => {
  it("marks a prompt as an invoke session and a plain prompt as not", () => {
    const marked = withInvokeSessionMarker("You are Lincoln.");
    expect(isInvokeSessionPrompt(marked)).toBe(true);
    expect(isInvokeSessionPrompt("You are Lincoln.")).toBe(false);
  });

  it("keeps the target definition's own prompt verbatim, only appending the marker", () => {
    const marked = withInvokeSessionMarker("You are Lincoln.");
    expect(marked.startsWith("You are Lincoln.")).toBe(true);
  });

  it("uses a stable, non-empty template key", () => {
    expect(INVOKE_TEMPLATE_KEY).toBe("myra-invoked-subagent");
  });

  it("survives the sidecar's prompt cleaning (stripSeedMarker) — the marker is load-bearing for director selection", () => {
    // The harness strips the seed marker (and collapses whitespace) from the
    // launched prompt BEFORE checking isInvokeSessionPrompt; if a prompt
    // reflow ever ate the invoke marker, the budget director would silently
    // not be selected.
    const launched = withInvokeSessionMarker(
      "You are Lincoln.\n\n<!-- workbench:memory-seed=MEMORY.md -->",
    );
    expect(isInvokeSessionPrompt(stripSeedMarker(launched))).toBe(true);
  });

  it("classifies personal-agent definitions (chat + triage variants) as non-invocable", () => {
    expect(isPersonalAgentDefinitionName(PERSONAL_AGENT_NAME)).toBe(true);
    expect(isPersonalAgentDefinitionName(PERSONAL_AGENT_TRIAGE_NAME)).toBe(
      true,
    );
    expect(isPersonalAgentDefinitionName("Lincoln")).toBe(false);
  });
});
