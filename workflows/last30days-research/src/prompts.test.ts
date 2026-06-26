import { describe, expect, test } from "bun:test";
import { buildGroundingSystemPrompt, buildWriterSystemPrompt } from "./prompts";

describe("buildWriterSystemPrompt", () => {
  const prompt = buildWriterSystemPrompt();

  test("keeps the fixed report skeleton in house-style voice/casing", () => {
    expect(prompt).toContain("What we found about");
    expect(prompt).toContain("Key patterns from the research");
    expect(prompt).toContain("Research by last30days via GTM Workbench");
  });

  test("scales report length to the evidence and forbids a fixed cap (CL-2496)", () => {
    const lower = prompt.toLowerCase();
    // The whole point of item 2: no fixed paragraph/pattern count; depth tracks
    // the evidence. These must fail if the prompt re-imposes a cap.
    expect(lower).toContain("scales to the evidence");
    expect(lower).toContain("never pad and never truncate");
    expect(lower).toMatch(/do not cap|never (a fixed|cap)/);
    expect(lower).toContain("past three");
  });

  test("requires weaving verbatim attributed community takes (LAW 9)", () => {
    expect(prompt.toLowerCase()).toContain("verbatim");
    expect(prompt.toLowerCase()).toContain("bestTakes".toLowerCase());
    expect(prompt).toMatch(/u\/name|@handle/);
  });

  test("labels engagement per source and forbids calling GitHub stars upvotes", () => {
    expect(prompt).toContain("stars");
    expect(prompt.toLowerCase()).toContain("points");
    expect(prompt.toLowerCase()).toContain("views");
    // GitHub must be tied to "stars", and the prompt must say not to call them upvotes
    expect(prompt.toLowerCase()).toMatch(/github.*stars|stars.*github/s);
    expect(prompt.toLowerCase()).toContain('never "upvotes"'.toLowerCase());
  });

  test("encodes source weighting (social/community over web/github)", () => {
    expect(prompt).toContain("Reddit");
    expect(prompt.toLowerCase()).toContain("weakest");
  });

  test("uses house style: collective voice and a true em dash for asides", () => {
    expect(prompt.toLowerCase()).toContain("em dash");
    expect(prompt.toLowerCase()).toContain(
      'collective voice ("we")'.toLowerCase(),
    );
    expect(prompt).not.toContain("What I learned");
  });
});

describe("buildGroundingSystemPrompt", () => {
  const prompt = buildGroundingSystemPrompt();

  test("asks for one tailored query per source as JSON only", () => {
    expect(prompt.toLowerCase()).toContain("json only");
    expect(prompt.toLowerCase()).toContain("tailor");
    // Every source the workflow fans out to must be a requested output key, or
    // that source falls back to the untailored topic.
    for (const key of [
      "hackernews",
      "github",
      "web",
      "reddit",
      "x",
      "youtube",
      "polymarket",
    ]) {
      expect(prompt).toContain(`"${key}"`);
    }
  });

  test("forbids reusing the raw topic verbatim across platforms", () => {
    expect(prompt.toLowerCase()).toContain("never reuse the raw topic");
  });
});
