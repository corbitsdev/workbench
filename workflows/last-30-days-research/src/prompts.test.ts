import { describe, expect, test } from "bun:test";
import {
  CORBITS_VOCABULARY,
  buildLast30DaysResearchSystemPrompt,
} from "./prompts";
import { LAST_30_DAYS_RESEARCH_SECTIONS } from "./index";

const prompt = buildLast30DaysResearchSystemPrompt(
  LAST_30_DAYS_RESEARCH_SECTIONS,
);

describe("CORBITS_VOCABULARY", () => {
  test("names every canonical Corbits term", () => {
    for (const term of ["Corbits", "Corbits.dev", "Interchange", "Faremeter"]) {
      expect(CORBITS_VOCABULARY).toContain(term);
    }
  });
});

describe("phase 1 — ground", () => {
  test("tailors a query per wired source and never reuses the raw topic verbatim", () => {
    expect(prompt).toMatch(/phase 1/i);
    expect(prompt.toLowerCase()).toContain("never reuse the raw topic");
    for (const key of ["web", "github"]) {
      expect(prompt.toLowerCase()).toContain(key);
    }
  });

  test("never asks for a source this deployment does not have wired", () => {
    const groundSection = prompt.slice(
      prompt.toLowerCase().indexOf("phase 1"),
      prompt.toLowerCase().indexOf("phase 2"),
    );
    for (const pending of ["reddit", "hacker news", "youtube", "polymarket"]) {
      expect(groundSection.toLowerCase()).not.toContain(pending);
    }
  });
});

describe("phase 2 & 4 — gather", () => {
  test("calls web_search and github_activity and names every not-yet-connected source honestly", () => {
    expect(prompt).toContain("web_search");
    expect(prompt).toContain("github_activity");
    expect(prompt.toLowerCase()).toContain("not yet connected");
    expect(prompt.toLowerCase()).toContain("never invent results");
  });
});

describe("phase 3 — extract entities", () => {
  test("targets discovered entities rather than the broad topic", () => {
    expect(prompt.toLowerCase()).toContain("named entities");
    expect(prompt.toLowerCase()).toContain("not the broad topic");
  });

  test("falls back to the base topic when a source found nothing usable", () => {
    expect(prompt.toLowerCase()).toContain("repeat the base topic");
  });
});

describe("phase 5 — curate", () => {
  test("folds in the OG's deterministic collect step: dedupe, date-filter, drop GitHub noise", () => {
    const lower = prompt.toLowerCase();
    expect(lower).toContain("dedup");
    expect(lower).toContain("last 30 days");
    expect(lower).toContain("github");
    expect(lower).toContain("50 stars");
  });

  test("requires grouping into a capped number of named themes", () => {
    expect(prompt.toLowerCase()).toContain("hard cap 5");
  });

  test("excerpts are optional, never fabricated", () => {
    const lower = prompt.toLowerCase();
    expect(lower).toContain("optional");
    expect(lower).toContain("never invent one");
  });

  test("requires an honest unreachable/not-connected accounting", () => {
    expect(prompt.toLowerCase()).toContain("unreachable");
  });
});

describe("phase 6 — write", () => {
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

  test("forbids inventing anything outside what the earlier phases surfaced", () => {
    expect(prompt.toLowerCase()).toContain("invent nothing");
  });

  test("requires an honest no-results state instead of padded empty sections", () => {
    expect(prompt).toContain("no source results to report for this topic");
  });
});
