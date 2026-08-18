import { describe, expect, test } from "bun:test";
import {
  CORBITS_VOCABULARY,
  buildCurateSystemPrompt,
  buildEntityExtractSystemPrompt,
  buildGroundingSystemPrompt,
  buildWriterSystemPrompt,
} from "./prompts";
import { LAST_30_DAYS_RESEARCH_SECTIONS } from "./index";

describe("CORBITS_VOCABULARY", () => {
  test("names every canonical Corbits term", () => {
    for (const term of ["Corbits", "Corbits.dev", "Interchange", "Faremeter"]) {
      expect(CORBITS_VOCABULARY).toContain(term);
    }
  });
});

describe("buildGroundingSystemPrompt", () => {
  const prompt = buildGroundingSystemPrompt();

  test("asks for one tailored query per wired source as JSON only", () => {
    expect(prompt.toLowerCase()).toContain("json only");
    expect(prompt.toLowerCase()).toContain("tailor");
    for (const key of ["web", "github"]) {
      expect(prompt).toContain(`"${key}"`);
    }
  });

  test("never asks for a source this deployment does not have wired", () => {
    for (const pending of ["reddit", "hacker news", "youtube", "polymarket"]) {
      expect(prompt.toLowerCase()).not.toContain(pending);
    }
  });

  test("forbids reusing the raw topic verbatim across platforms", () => {
    expect(prompt.toLowerCase()).toContain("never reuse the raw topic");
  });
});

describe("buildEntityExtractSystemPrompt", () => {
  const prompt = buildEntityExtractSystemPrompt();

  test("asks for entity-focused follow-up queries per wired source as JSON only", () => {
    expect(prompt.toLowerCase()).toContain("json only");
    for (const key of ["web", "github"]) {
      expect(prompt).toContain(`"${key}"`);
    }
  });

  test("targets discovered entities rather than the broad topic", () => {
    expect(prompt.toLowerCase()).toContain("named entities");
    expect(prompt.toLowerCase()).toContain("not the broad topic");
  });

  test("falls back to the base topic when a source found nothing usable", () => {
    expect(prompt.toLowerCase()).toContain("repeat the base topic");
  });
});

describe("buildCurateSystemPrompt", () => {
  const prompt = buildCurateSystemPrompt();

  test("folds in the OG's deterministic collect step: dedupe, date-filter, drop GitHub noise", () => {
    const lower = prompt.toLowerCase();
    expect(lower).toContain("dedup");
    expect(lower).toContain("last 30 days");
    expect(lower).toContain("github");
    expect(lower).toContain("50 stars");
  });

  test("requires grouping into a capped number of named themes with backing item urls", () => {
    const lower = prompt.toLowerCase();
    expect(lower).toContain("hard cap 5");
    expect(prompt).toContain('"itemUrls"');
  });

  test("excerpts are optional, never fabricated, and json-only output", () => {
    const lower = prompt.toLowerCase();
    expect(lower).toContain("optional");
    expect(prompt).toContain('"excerpts"');
    expect(lower).toContain("json only");
  });

  test("requires an honest skippedSources accounting", () => {
    expect(prompt).toContain('"skippedSources"');
    expect(prompt.toLowerCase()).toContain("unreachable");
  });
});

describe("buildWriterSystemPrompt", () => {
  const prompt = buildWriterSystemPrompt(LAST_30_DAYS_RESEARCH_SECTIONS);

  test("encodes this deployment's own four-heading report contract, in order", () => {
    let lastIndex = -1;
    for (const heading of LAST_30_DAYS_RESEARCH_SECTIONS) {
      const index = prompt.indexOf(heading);
      expect(index).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
  });

  test("requires every claim in Key findings to trace to a citation", () => {
    expect(prompt.toLowerCase()).toContain(
      "every claim here must trace to a citation",
    );
  });

  test("uses house style: collective voice and hyphen-spaced asides, not I", () => {
    const lower = prompt.toLowerCase();
    expect(lower).toContain('collective voice ("we")');
    expect(lower).toContain("not em dashes");
  });

  test("forbids inventing anything outside the brief", () => {
    expect(prompt.toLowerCase()).toContain("invent nothing");
  });

  test("requires an honest no-results state instead of padded empty sections", () => {
    expect(prompt).toContain("no source results to report for this topic");
  });
});
