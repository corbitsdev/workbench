import { describe, expect, it } from "bun:test";
import { buildPersonalAgentSystemPrompt } from "./prompt";

const xmlFormat = { xml: true };
const markdownFormat = { xml: false };

describe("buildPersonalAgentSystemPrompt", () => {
  it("frames the named agent as Chief of Staff and company brain for one person", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", xmlFormat);
    expect(prompt).toContain(
      "You are Myra, Chief of Staff to the one person you work for",
    );
    expect(prompt).toContain("the company's brain");
  });

  it("interpolates whatever name is supplied", () => {
    const prompt = buildPersonalAgentSystemPrompt("Assistant", xmlFormat);
    expect(prompt).toContain("You are Assistant, Chief of Staff");
  });

  it("includes the role, ownership, knowledge, and style sections", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", xmlFormat);
    expect(prompt).toContain("<role>");
    expect(prompt).toContain("<ownership>");
    expect(prompt).toContain("<knowledge>");
    expect(prompt).toContain("<style>");
  });

  // Tools are discovered dynamically from the function list — the prompt must
  // NOT hardcode tool names (which go stale and, when prefixed, fail to
  // round-trip through the model). The prompt instead defers to the function list.
  it("hardcodes no package tool names and defers to the function list", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", xmlFormat);
    for (const stale of [
      "exa_search",
      "exa__search",
      "granola_list_notes",
      "attio_query_records",
      "linear_list_issues",
      "artifact_create",
      "list_agents",
      "read_file",
    ]) {
      expect(prompt).not.toContain(stale);
    }
    expect(prompt).toContain("Your function list is the source of truth");
    expect(prompt).toContain("call a tool by the exact name it gives");
  });

  it("no longer advertises mail tools or a delegation section", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", xmlFormat);
    expect(prompt).not.toContain("mail_send");
    expect(prompt).not.toContain("<delegation>");
    expect(prompt).not.toContain("PENDING.md");
  });

  it("coordinates expertise rather than claiming authority", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", xmlFormat);
    expect(prompt).toContain("coordinate expertise");
  });

  it("directs the agent to confirm before irreversible or high-stakes actions", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", xmlFormat);
    expect(prompt.toLowerCase()).toContain("irreversible");
  });

  it("applies the person’s known way of working rather than a generic default", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", xmlFormat);
    expect(prompt).toContain("Apply what you already know about how they work");
    expect(prompt).toContain("not a generic default");
  });

  it("forbids fabrication and impersonation of the person served", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", xmlFormat);
    expect(prompt).toContain("Never fabricate information");
    expect(prompt).toContain("Never impersonate the person you work for");
  });

  it("carries a concise style note rather than the full humanizer essay", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", xmlFormat);
    expect(prompt).toContain("No emojis unless explicitly requested");
    expect(prompt).not.toContain("superficial -ing analyses");
    expect(prompt).not.toContain("negative parallelisms");
  });

  it("respects the requested output format", () => {
    expect(buildPersonalAgentSystemPrompt("Myra", xmlFormat)).toContain(
      "<role>",
    );
    expect(buildPersonalAgentSystemPrompt("Myra", markdownFormat)).toContain(
      "## Role",
    );
  });

  // Effort calibration — no tool-spam on a greeting
  it("calibrates effort so greetings get a direct reply without tool use", () => {
    const prompt = buildPersonalAgentSystemPrompt(
      "Myra",
      xmlFormat,
    ).toLowerCase();
    expect(prompt).toContain("match your effort to the request");
    expect(prompt).toContain("greeting");
    expect(prompt).toContain("without running tools");
  });

  // Voice — operator framing stays internal
  it('keeps the operator framing internal — no reciting a title or calling them "operator"', () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", xmlFormat);
    expect(prompt).toContain("do not announce your title");
    expect(prompt).toContain('Never call them "your operator" out loud');
  });

  // Internal-first: company knowledge is primary, web search is supplemental
  it("directs the agent to reach for company knowledge before web search", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", xmlFormat);
    expect(prompt).toContain(
      "reach for what the company already knows before anything else",
    );
    expect(prompt).toContain("Web search is supplemental");
  });

  // A named company/person/deal grounds in internal context before reaching out
  it("checks what is already known about a named company, person, or deal first", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", xmlFormat);
    expect(prompt).toContain("When a request names a company, person, or deal");
    expect(prompt).toContain(
      "lead with that internal picture before adding outside context",
    );
  });

  // Gather intensely but efficiently — most direct instrument, shortest path
  it("directs intense but efficient gathering, not broad repeated calls", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", xmlFormat);
    expect(prompt).toContain(
      "One targeted read or scrape beats fifty broad listings",
    );
    expect(prompt).toContain("do not re-pull what you already hold");
  });

  // Temporal/recency requests fetch fresh, never a stale snapshot
  it("requires fresh data from the owning source for time-bound requests", () => {
    const prompt = buildPersonalAgentSystemPrompt(
      "Myra",
      xmlFormat,
    ).toLowerCase();
    expect(prompt).toContain("my last call");
    expect(prompt).toContain("snapshots, not current state");
  });

  // Self-notes convention — one durable slot only (SCRATCHPAD dropped)
  it("documents MEMORY.md as the single durable memory file", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", xmlFormat);
    expect(prompt).toContain("<notes>");
    expect(prompt).toContain("MEMORY.md");
    expect(prompt).not.toContain("SCRATCHPAD.md");
  });

  it("no longer carries the retired CONTACTS/ERRORS/HUMAN memory files", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", xmlFormat);
    for (const file of ["CONTACTS.md", "ERRORS.md", "HUMAN.md"]) {
      expect(prompt).not.toContain(file);
    }
  });

  // Per-operator appendix
  it("appends an operator section only when a profile is supplied", () => {
    const base = buildPersonalAgentSystemPrompt("Myra", xmlFormat);
    expect(base).not.toContain("<operator>");

    const withProfile = buildPersonalAgentSystemPrompt("Myra", xmlFormat, {
      operatorProfile:
        "You work for Sawyer Cutler, lead product engineer at Corbits.",
    });
    expect(withProfile).toContain("<operator>");
    expect(withProfile).toContain("Sawyer Cutler");
  });

  it("renders the operator section heading in markdown when xml is off", () => {
    const withProfile = buildPersonalAgentSystemPrompt("Myra", markdownFormat, {
      operatorProfile: "You work for Sawyer.",
    });
    expect(withProfile).toContain("## Operator");
  });

  it("ignores a blank operator profile", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", xmlFormat, {
      operatorProfile: "   ",
    });
    expect(prompt).not.toContain("<operator>");
  });

  // A referenced document id should be loaded directly, not asked about
  it("directs Myra to load a referenced document id rather than ask for it", () => {
    const prompt = buildPersonalAgentSystemPrompt(
      "Myra",
      xmlFormat,
    ).toLowerCase();
    expect(prompt).toContain("that document is the subject of the request");
    expect(prompt).toContain("load its content before responding");
  });

  it("keeps the document-load nudge consistent with the <knowledge> recency rules", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", xmlFormat);
    expect(prompt).toContain("<knowledge> recency rules still govern");
  });

  // CL-1952 — the base prompt carries the memory-seed marker so the sidecar can
  // parse the file list out of the effective (personalized) prompt.
  it("embeds the memory-seed marker in the base prompt regardless of format", () => {
    expect(buildPersonalAgentSystemPrompt("Myra", xmlFormat)).toContain(
      "<!-- workbench:memory-seed=",
    );
    expect(buildPersonalAgentSystemPrompt("Myra", markdownFormat)).toContain(
      "<!-- workbench:memory-seed=",
    );
  });
});
