import { describe, expect, test } from "bun:test";
import {
  PERSONAL_AGENT_IDENTITY_MARKER,
  hasPersonalAgentIdentityMarker,
  isPersonalAgentIdentityPrompt,
  stripPersonalAgentIdentityMarker,
  withPersonalAgentIdentityMarker,
} from "./personal-agent-identity";
import { buildPersonalAgentSystemPrompt } from "./prompt";
import {
  PERSONAL_AGENT_NAME,
  PERSONAL_AGENT_PROMPT_FORMAT,
} from "./definition";

describe("personal-agent identity marker (CL-3194)", () => {
  test("stamps the marker once and is idempotent", () => {
    const once = withPersonalAgentIdentityMarker("You are Myra.");
    expect(once).toContain(PERSONAL_AGENT_IDENTITY_MARKER);
    expect(once).toBe(withPersonalAgentIdentityMarker(once));
  });

  test("detects the marker regardless of whitespace inside the comment", () => {
    expect(
      hasPersonalAgentIdentityMarker("x\n\n<!-- workbench:personal-agent -->"),
    ).toBe(true);
    expect(
      hasPersonalAgentIdentityMarker(
        "x\n\n<!--  workbench:personal-agent  -->",
      ),
    ).toBe(true);
    expect(isPersonalAgentIdentityPrompt("You are Oat.")).toBe(false);
  });

  test("strips the marker and collapses leftover blank lines", () => {
    const stamped = withPersonalAgentIdentityMarker("Role prose.\n\nMore.");
    const cleaned = stripPersonalAgentIdentityMarker(stamped);
    expect(cleaned).not.toContain("workbench:personal-agent");
    expect(cleaned).toBe("Role prose.\n\nMore.");
  });

  test("the real built personal-agent prompt always carries the marker", () => {
    const real = buildPersonalAgentSystemPrompt(
      PERSONAL_AGENT_NAME,
      PERSONAL_AGENT_PROMPT_FORMAT,
    );
    expect(hasPersonalAgentIdentityMarker(real)).toBe(true);
  });

  test("rewriting the role opening still leaves the marker intact", () => {
    const real = buildPersonalAgentSystemPrompt(
      PERSONAL_AGENT_NAME,
      PERSONAL_AGENT_PROMPT_FORMAT,
    );
    const rewritten = real.replace(
      /You are Myra, Chief of Staff[^<\n]*/,
      "You are Myra, a personal GTM assistant",
    );
    expect(rewritten).not.toContain("Chief of Staff");
    expect(hasPersonalAgentIdentityMarker(rewritten)).toBe(true);
  });
});
