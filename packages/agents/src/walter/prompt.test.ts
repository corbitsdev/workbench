import { describe, expect, it } from "bun:test";
import { buildWalterSystemPrompt } from "./prompt";

describe("buildWalterSystemPrompt", () => {
  it("includes the agent name in the role section", () => {
    const prompt = buildWalterSystemPrompt("Walter", { xml: true });
    expect(prompt).toContain("Walter");
  });

  it("instructs giving the piece directly rather than describing a file write", () => {
    const prompt = buildWalterSystemPrompt("Walter", { xml: true });
    expect(prompt).toContain(
      "always give the piece directly in your reply rather than describing a file you wrote",
    );
  });

  it("gates artifact_link_file on a file that already exists, not a write tool", () => {
    const prompt = buildWalterSystemPrompt("Walter", { xml: true });
    expect(prompt).toContain("artifact_link_file");
    expect(prompt).toContain(
      "if a file already exists at a known workspace path",
    );
  });

  it("does not instruct any retired posix runner tool", () => {
    const prompt = buildWalterSystemPrompt("Walter", { xml: true });
    for (const retired of [
      "read_file",
      "write_file",
      "edit_file",
      "search_files",
      "run_shell",
      "grep",
    ]) {
      expect(prompt).not.toContain(retired);
    }
  });
});
