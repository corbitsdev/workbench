import { describe, expect, it } from "bun:test";
import { FREDDIE_DEPLOY_PROMPT } from "./prompt";

describe("Freddie prompt", () => {
  it("uses the public Claude Fable 5 system prompt content", () => {
    expect(FREDDIE_DEPLOY_PROMPT).toContain(
      "# Claude Fable 5 -- Complete System Prompt",
    );
    expect(FREDDIE_DEPLOY_PROMPT).toContain(
      "Claude should never use `voice_note` blocks",
    );
    expect(FREDDIE_DEPLOY_PROMPT).toContain(
      "This iteration of Claude is Claude Fable 5",
    );
  });
});
