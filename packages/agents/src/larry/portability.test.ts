import { describe, expect, it } from "bun:test";
import { LARRY_SKILL_CONTENT } from "./skill";
import { LARRY_CAPABILITIES, LARRY_DEPLOY_DESCRIPTOR } from "./definition";
import { buildLarrySystemPrompt } from "./prompt";

describe("Larry skill portability", () => {
  it("a Myra-shaped config with LARRY_SKILL_CONTENT has the same skill section as Larry", () => {
    const larryPrompt = buildLarrySystemPrompt("Larry");

    // Simulate embedding the same skill into a Myra-shaped system prompt
    const myraWithLarrySkillPrompt = `You are Myra, a research agent. When asked to research a topic, follow the skill below. Always call write_artifact to persist your output — never return raw research text as your final answer.

<available_skills>
${LARRY_SKILL_CONTENT}
</available_skills>`;

    // Both prompts must contain the identical skill content block
    expect(larryPrompt).toContain(LARRY_SKILL_CONTENT);
    expect(myraWithLarrySkillPrompt).toContain(LARRY_SKILL_CONTENT);
  });

  it("a skill-equipped Myra tool list matches Larry tool list", () => {
    const larryTools = [...LARRY_CAPABILITIES.tools].sort();

    // Myra equipped with the last30days skill would need the same tools
    const myraWithLarrySkillTools = [
      "hackernews_search",
      "github_activity",
      "polymarket_odds",
      "exa_search",
      "last30days_core_extract",
      "last30days_core_report",
      "last30days_validate",
      "write_artifact",
      "reddit_search",
      "reddit_subreddit_search",
      "x_search",
      "scrapecreators_tiktok",
      "scrapecreators_instagram",
      "scrapecreators_threads",
      "scrapecreators_pinterest",
      "mail_search",
      "mail_reply",
    ].sort();

    expect(myraWithLarrySkillTools).toEqual(larryTools);
  });

  it("LARRY_DEPLOY_DESCRIPTOR requiredTools and defaultTools are identical", () => {
    expect(LARRY_DEPLOY_DESCRIPTOR.defaultTools.sort()).toEqual(
      LARRY_DEPLOY_DESCRIPTOR.requiredTools.sort(),
    );
  });
});
