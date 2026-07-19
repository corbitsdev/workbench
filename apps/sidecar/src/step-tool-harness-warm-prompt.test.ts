// Re-home guard for the warm single-step agent prompt handling. The retired
// in-process default-harness resolved+stripped the hub's control-plane markers
// (memory-seed, member-timezone, inference-params, personal-agent identity) and
// appended the live active-context block; the runtime-retirement pin bump
// dropped that, so the markers leaked into the model prompt and the agent lost
// its live-date awareness. `prepareWarmAgentPrompt` re-homes it. These pin the
// contract.

import { describe, test, expect } from "bun:test";

import { buildTimeZoneMarker } from "@workbench/prompts";
import {
  PERSONAL_AGENT_IDENTITY_MARKER,
  buildInferenceParamsMarker,
  buildPersonalAgentSystemPrompt,
  PERSONAL_AGENT_NAME,
  type ResolvedInferenceDials,
} from "@workbench/myra";
import { resolveDynamicToolConfig } from "@workbench/agents";

import { prepareWarmAgentPrompt } from "./step-tool-harness";

const DIALS: ResolvedInferenceDials = {
  model: "claude-opus-4-8",
  creative: 40,
  thinking: 60,
};

// A memory-seed marker naming an (unregistered) file: the seed table is empty
// today, so no file is seeded, but the marker MUST still be stripped from the
// prompt rather than leaking as raw text.
const SEED_MARKER = "<!-- workbench:memory-seed=notes.md -->";

describe("prepareWarmAgentPrompt", () => {
  const rawPrompt = [
    "You are Myra.",
    SEED_MARKER,
    buildTimeZoneMarker("America/Los_Angeles"),
    buildInferenceParamsMarker(DIALS),
    PERSONAL_AGENT_IDENTITY_MARKER,
  ].join("\n\n");

  test("strips every control-plane marker so none leaks into the model prompt", () => {
    const now = new Date("2026-07-17T12:00:00Z");
    const { systemPrompt } = prepareWarmAgentPrompt(rawPrompt, now);

    expect(systemPrompt).not.toContain("workbench:memory-seed");
    expect(systemPrompt).not.toContain("workbench:timezone");
    expect(systemPrompt).not.toContain("workbench:inference-params");
    expect(systemPrompt).not.toContain("workbench:personal-agent");
    // The static base text survives.
    expect(systemPrompt).toContain("You are Myra.");
  });

  test("appends the live active-context block (agent is not anchored to its training cutoff)", () => {
    const now = new Date("2026-07-17T12:00:00Z");
    const { systemPrompt } = prepareWarmAgentPrompt(rawPrompt, now);

    expect(systemPrompt).toContain("Active Context");
    expect(systemPrompt).toContain("Current date");
    // The rendered block carries the live date, not a stale training-cutoff one.
    expect(systemPrompt).toContain("2026");
  });

  test("returns the member inference dials to thread via env (so stripping the marker does not lose them)", () => {
    const { inferenceDials } = prepareWarmAgentPrompt(rawPrompt, new Date());
    expect(inferenceDials).toEqual(DIALS);
  });

  test("a prompt with no markers still gets the active-context block and no dials", () => {
    const { systemPrompt, inferenceDials, seedFiles } = prepareWarmAgentPrompt(
      "You are a plain agent.",
      new Date("2026-07-17T12:00:00Z"),
    );
    expect(systemPrompt).toContain("You are a plain agent.");
    expect(systemPrompt).toContain("Active Context");
    expect(systemPrompt).toContain("Current date");
    expect(inferenceDials).toBeUndefined();
    expect(seedFiles).toEqual([]);
  });

  // Launch-to-sidecar seam (CL-3194): the composed personal-agent prompt still
  // opts into dynamic tools on the raw (marker-carrying) prompt, and the model
  // never sees the identity marker after prepareWarmAgentPrompt.
  test("composed personal-agent prompt opts into dynamic tools; identity marker is stripped before the model", () => {
    const composed = buildPersonalAgentSystemPrompt(PERSONAL_AGENT_NAME, {
      xml: false,
    });
    expect(resolveDynamicToolConfig(composed)).toBeDefined();

    const { systemPrompt } = prepareWarmAgentPrompt(
      composed,
      new Date("2026-07-17T12:00:00Z"),
    );
    expect(systemPrompt).not.toContain("workbench:personal-agent");
    expect(systemPrompt).toContain("You are Myra");
    // Role prose stays model-facing; only the control marker is stripped.
    expect(systemPrompt).toContain("Chief of Staff");
  });
});
