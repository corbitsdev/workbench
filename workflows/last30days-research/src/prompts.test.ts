import { describe, expect, test } from "bun:test";
import {
  buildCurateSystemPrompt,
  buildEntityExtractSystemPrompt,
  buildGroundingSystemPrompt,
  buildWriterSystemPrompt,
} from "./prompts";

describe("buildWriterSystemPrompt (Larry structure, CL-2503)", () => {
  const prompt = buildWriterSystemPrompt();

  test("encodes the Larry report skeleton: title, TL;DR, themes, contested", () => {
    expect(prompt).toContain("What People Actually Said (Last 30 Days)");
    expect(prompt).toContain("**TL;DR**");
    expect(prompt).toContain("What's still open / contested");
  });

  // CL-4338: the app renders a single deduped/linked sources section from
  // brief.citations. If the writer prompt also tells the model to emit its
  // own "## Sources" heading, the persisted body carries a second, duplicate
  // section alongside the app-rendered one.
  test("forbids the model from emitting its own Sources/Citations section", () => {
    expect(prompt).not.toContain("## Sources\nA deduped");
    expect(prompt.toLowerCase()).toContain('do not append a "## sources"');
  });

  test("builds one section per theme/cluster and scales depth to the evidence", () => {
    const lower = prompt.toLowerCase();
    expect(lower).toContain("section per cluster");
    expect(lower).toContain("never pad, never truncate");
  });

  test("requires at least three verbatim attributed community quotes from bestTakes", () => {
    const lower = prompt.toLowerCase();
    expect(lower).toContain("verbatim");
    expect(lower).toContain("besttakes");
    expect(lower).toContain("at least 3");
    expect(prompt).toMatch(/u\/name|@handle/);
  });

  test("labels engagement per source and forbids calling GitHub stars upvotes", () => {
    expect(prompt.toLowerCase()).toContain("points");
    expect(prompt.toLowerCase()).toContain("views");
    expect(prompt.toLowerCase()).toMatch(/github.*stars|stars.*github/s);
    expect(prompt.toLowerCase()).toContain('never "upvotes"'.toLowerCase());
  });

  test("uses house style: collective voice and hyphen-spaced asides, not I", () => {
    const lower = prompt.toLowerCase();
    expect(lower).toContain('collective voice ("we")');
    expect(lower).toContain("not em dashes");
    expect(prompt).not.toContain("What I learned");
  });

  test("forbids inventing anything outside the brief", () => {
    expect(prompt.toLowerCase()).toContain("invent nothing");
  });
});

describe("buildCurateSystemPrompt (CL-2503)", () => {
  const prompt = buildCurateSystemPrompt();

  test("instructs dropping promo/shill junk", () => {
    const lower = prompt.toLowerCase();
    expect(lower).toContain("drop the junk");
    expect(lower).toContain("shill");
    expect(lower).toContain("ama");
  });

  test("requires grouping into a few named themes with backing item urls", () => {
    const lower = prompt.toLowerCase();
    expect(lower).toContain("3-6 real themes");
    expect(prompt).toContain('"itemUrls"');
  });

  test("requires selecting verbatim attributed quotes with engagement and json-only output", () => {
    const lower = prompt.toLowerCase();
    expect(lower).toContain("verbatim quotes");
    expect(prompt).toContain('"engagement"');
    expect(lower).toContain("json only");
  });
});

describe("buildEntityExtractSystemPrompt (CL-2503)", () => {
  const prompt = buildEntityExtractSystemPrompt();

  test("asks for entity-focused follow-up queries per round-2 source as JSON only", () => {
    expect(prompt.toLowerCase()).toContain("json only");
    for (const key of ["web", "reddit", "x", "youtube"]) {
      expect(prompt).toContain(`"${key}"`);
    }
  });

  test("targets discovered entities rather than the broad topic", () => {
    expect(prompt.toLowerCase()).toContain("named entities");
    expect(prompt.toLowerCase()).toContain("not the broad topic");
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
