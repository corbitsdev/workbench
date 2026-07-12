import { describe, expect, it } from "bun:test";
import { buildPersonalAgentSystemPrompt } from "./prompt";
import { PERSONAL_AGENT_BASE_TOOLS } from "./definition";

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

  it("uses canonical Corbits terminology when interpreting source material", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", xmlFormat);
    expect(prompt).toContain("<terminology>");
    expect(prompt).toContain(
      "Corbits, Corbits.dev, Interchange, and Faremeter",
    );
    expect(prompt).toContain("clear speech-to-text or spelling variant");
    expect(prompt).toContain("ambiguous term");
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

  it("no longer advertises a delegation section", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", xmlFormat);
    expect(prompt).not.toContain("<delegation>");
    expect(prompt).not.toContain("PENDING.md");
  });

  // CL-3407: Myra can send a note to a teammate's mailbox using the
  // @-mention token's bare id and her own mail domain. The address format is
  // not discoverable from a function list the way a tool name is, so the
  // prompt hardcodes this one addressing convention.
  it("directs mail_send addressing via the mention token and own mail domain", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", xmlFormat);
    expect(prompt).toContain("@[Name](#usr_<id>)");
    expect(prompt).toContain("usr_<id>");
    expect(prompt).toContain("your own mail domain");
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

  // CL-2413: durable memory is a hub-owned store reached via memory tools, not a
  // file. The notes section teaches the load→edit→save-whole discipline and no
  // longer names any memory file.
  it("documents memory as a tool-accessed store with the load-edit-save discipline", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", xmlFormat);
    expect(prompt).toContain("<notes>");
    expect(prompt).toContain("reach it through your memory tools, not a file");
    expect(prompt).toContain(
      "saving replaces what is stored, it does not append",
    );
  });

  it("no longer references any memory file", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", xmlFormat);
    for (const file of [
      "MEMORY.md",
      "SCRATCHPAD.md",
      "CONTACTS.md",
      "ERRORS.md",
      "HUMAN.md",
    ]) {
      expect(prompt).not.toContain(file);
    }
  });

  // A capability the user names may be a skill, a workflow, or a loadable tool —
  // Myra must sweep all three catalogs before claiming absence, rather than
  // checking the skill library alone and stopping (the reported bug where she said
  // "no last 30 days skill" while Last30Days exists as a workflow).
  it("teaches that an empty skill search is not proof a capability is absent", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", xmlFormat);
    expect(prompt).toContain(
      "search_skills will never surface it no matter how you word the query",
    );
    expect(prompt).toContain(
      "an empty skill search is not proof the capability is absent",
    );
  });

  it("treats skills, workflows, and tools as one capability space the user names loosely", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", xmlFormat);
    expect(prompt).toContain(
      "may live as a skill, a deployed workflow, or a loadable tool",
    );
    expect(prompt).toContain(
      'a "last 30 days" recap, for example, is a workflow',
    );
  });

  it("requires sweeping all three catalogs before claiming a capability is unavailable", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", xmlFormat);
    expect(prompt).toContain(
      "before telling anyone it is unavailable, look across all three catalogs",
    );
    expect(prompt).toContain("search_skills");
    expect(prompt).toContain("workflow_list_kinds");
    expect(prompt).toContain("search_tools");
  });

  // The discovery guidance only works if the tools it names are actually
  // available to Myra. This guards the seam: if a catalog tool is renamed or
  // dropped from the base toolset, the prompt would keep telling her to call a
  // tool she no longer has — a re-run of the original bug — while every
  // substring assertion above stays green. Pin the prompt's named tools to the
  // resolved base toolset so drift fails a test instead of shipping silently.
  it("only names catalog tools Myra actually carries in her base toolset", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", xmlFormat);
    // Base tools resolve to canonical `<factoryId>:<tool>` names, so a prose
    // name matches either verbatim (bare local tools like search_tools) or as
    // the suffix after the `:` (package tools like search_skills →
    // @workbench/tools-skills/skills:search_skills).
    const carries = (tool: string): boolean =>
      PERSONAL_AGENT_BASE_TOOLS.some(
        (name) => name === tool || name.endsWith(`:${tool}`),
      );
    for (const tool of [
      "search_skills",
      "workflow_list_kinds",
      "search_tools",
    ]) {
      expect(prompt).toContain(tool);
      expect(carries(tool)).toBe(true);
    }
  });

  it("scopes the three-catalog sweep to the absence check, not every task", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", xmlFormat);
    expect(prompt).toContain("If one of them answers the request, act on it");
    expect(prompt).toContain(
      "the full sweep is the bar for concluding something is absent, not a step to run on every task",
    );
  });

  it("checks workflow_list_kinds before claiming a workflow does not exist, not only before starting", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", xmlFormat);
    expect(prompt).toContain(
      "call it too before telling anyone a workflow does not exist",
    );
    expect(prompt).toContain(
      "a request that sounds like a skill or a one-off task may be a deployed workflow kind",
    );
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

  // CL-2413 — memory moved off the filesystem, so the prompt no longer seeds a
  // file or carries the memory-seed marker (the CL-1952 marker is retired here).
  it("no longer embeds a memory-seed marker", () => {
    expect(buildPersonalAgentSystemPrompt("Myra", xmlFormat)).not.toContain(
      "workbench:memory-seed",
    );
    expect(
      buildPersonalAgentSystemPrompt("Myra", markdownFormat),
    ).not.toContain("workbench:memory-seed");
  });
});
