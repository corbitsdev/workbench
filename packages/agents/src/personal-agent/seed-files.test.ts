/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import { buildPersonalAgentSystemPrompt } from "./prompt";
import {
  PERSONAL_AGENT_SEED_FILES,
  buildSeedMarker,
  parseSeedMarker,
  stripSeedMarker,
  hasSeedMarker,
} from "./seed-files";

const EXPECTED_FILES = ["MEMORY.md"];

describe("PERSONAL_AGENT_SEED_FILES (CL-1952)", () => {
  it("declares MEMORY.md as the single durable memory file", () => {
    expect(PERSONAL_AGENT_SEED_FILES.map((f) => f.path).sort()).toEqual(
      [...EXPECTED_FILES].sort(),
    );
  });

  it("no longer seeds the transient SCRATCHPAD.md", () => {
    expect(PERSONAL_AGENT_SEED_FILES.map((f) => f.path)).not.toContain(
      "SCRATCHPAD.md",
    );
  });

  it("gives every seed file a stub that opens with a markdown header", () => {
    for (const file of PERSONAL_AGENT_SEED_FILES) {
      expect(file.content.startsWith("# ")).toBe(true);
    }
  });
});

describe("parseSeedMarker (CL-1952)", () => {
  it("returns the declared files with their stub content for the base deploy prompt", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", { xml: true });
    const resolved = parseSeedMarker(prompt);
    expect(resolved.map((f) => f.path).sort()).toEqual(
      [...EXPECTED_FILES].sort(),
    );
    for (const file of resolved) {
      expect(file.content.startsWith("# ")).toBe(true);
    }
  });

  it("still resolves the files when the prompt is personalized with an appended operator section", () => {
    // Mirrors composePersonalAgentPromptForInstance: the hub appends an
    // <operator> section before launch. Exact-equality matching the whole
    // prompt fails here — the marker survives because the builder embeds it.
    const personalized = buildPersonalAgentSystemPrompt(
      "Myra",
      { xml: true },
      {
        operatorProfile:
          "You work for Sawyer Cutler, lead product engineer at Corbits.",
      },
    );
    expect(personalized).toContain("<operator>");

    const resolved = parseSeedMarker(personalized);
    expect(resolved.map((f) => f.path).sort()).toEqual(
      [...EXPECTED_FILES].sort(),
    );
  });

  it("mirrors the harness flow: parse off the base prompt, then strip before the model prompt is built", () => {
    // The harness parses the file list off the RAW base prompt, strips the
    // marker, THEN appends active context. The marker and active-context block
    // never coexist in the prompt the model sees, so this models that ordering.
    const base = buildPersonalAgentSystemPrompt("Myra", { xml: false });
    const resolved = parseSeedMarker(base);
    expect(resolved.map((f) => f.path).sort()).toEqual(
      [...EXPECTED_FILES].sort(),
    );

    const modelPrompt = `${stripSeedMarker(base)}\n\n## Active Context\nCurrent date: 15/06/2026`;
    expect(modelPrompt).not.toContain("workbench:memory-seed");
  });

  it("returns no files for a prompt with no marker (non-personal agent)", () => {
    expect(parseSeedMarker("some other agent prompt with no marker")).toEqual(
      [],
    );
  });

  it("ignores retired seed basenames still present in legacy deployed prompts", () => {
    const legacy = "<!-- workbench:memory-seed=MEMORY.md,SCRATCHPAD.md -->";
    const resolved = parseSeedMarker(`prelude\n\n${legacy}`);
    expect(resolved.map((f) => f.path)).toEqual(["MEMORY.md"]);
  });

  // Regression: CONTACTS/ERRORS/HUMAN/PENDING were folded into MEMORY.md but
  // not retired, so prod Myra sessions deployed with the old prompt failed
  // restore with "no stub content is registered". Each must now be skipped,
  // leaving only the still-seeded MEMORY.md, without throwing.
  it.each(["CONTACTS.md", "ERRORS.md", "HUMAN.md", "PENDING.md"])(
    "skips the folded-and-retired %s without throwing",
    (retired) => {
      const legacy = `<!-- workbench:memory-seed=MEMORY.md,${retired} -->`;
      let resolved: ReturnType<typeof parseSeedMarker> = [];
      expect(() => {
        resolved = parseSeedMarker(`prelude\n\n${legacy}`);
      }).not.toThrow();
      expect(resolved.map((f) => f.path)).toEqual(["MEMORY.md"]);
    },
  );

  it("skips a marker listing every retired basename at once and seeds only MEMORY.md", () => {
    const legacy =
      "<!-- workbench:memory-seed=MEMORY.md,CONTACTS.md,ERRORS.md,HUMAN.md,PENDING.md,SCRATCHPAD.md -->";
    const resolved = parseSeedMarker(`prelude\n\n${legacy}`);
    expect(resolved.map((f) => f.path)).toEqual(["MEMORY.md"]);
  });

  it("throws when the marker names a file with no registered stub", () => {
    const rogue = buildSeedMarker([
      { path: "UNKNOWN.md", content: "# Unknown\n" },
    ]);
    expect(() => parseSeedMarker(`prelude\n\n${rogue}`)).toThrow("UNKNOWN.md");
  });

  it("rejects a marker entry that is not a plain basename (path traversal)", () => {
    const rogue = buildSeedMarker([{ path: "../../etc/passwd", content: "x" }]);
    expect(() => parseSeedMarker(`prelude\n\n${rogue}`)).toThrow(
      "plain basename",
    );
  });
});

describe("stripSeedMarker (CL-1952)", () => {
  it("removes the marker so the model never sees the control-plane sentinel", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", { xml: true });
    // The base prompt carries the marker; parsing must still resolve all files.
    expect(
      parseSeedMarker(prompt)
        .map((f) => f.path)
        .sort(),
    ).toEqual([...EXPECTED_FILES].sort());

    const cleaned = stripSeedMarker(prompt);
    expect(cleaned).not.toContain("workbench:memory-seed");
    expect(cleaned).not.toContain("<!--");
  });

  it("preserves the substantive prompt body when stripping the marker", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", { xml: true });
    const cleaned = stripSeedMarker(prompt);
    expect(cleaned).toContain("You are Myra, Chief of Staff");
    expect(cleaned).toContain("<role>");
  });

  it("is a no-op for a prompt with no marker", () => {
    expect(stripSeedMarker("plain prompt, no marker")).toBe(
      "plain prompt, no marker",
    );
  });

  it("round-trips: build then parse then strip", () => {
    const marker = buildSeedMarker(PERSONAL_AGENT_SEED_FILES);
    const body = "<role>do things</role>";
    const prompt = `${body}\n\n${marker}`;
    expect(
      parseSeedMarker(prompt)
        .map((f) => f.path)
        .sort(),
    ).toEqual([...EXPECTED_FILES].sort());
    expect(stripSeedMarker(prompt)).toBe(body);
  });
});

describe("hasSeedMarker (CL-1952)", () => {
  it("detects a present marker and the absence of one", () => {
    expect(
      hasSeedMarker(buildPersonalAgentSystemPrompt("Myra", { xml: true })),
    ).toBe(true);
    expect(hasSeedMarker("no marker here")).toBe(false);
  });

  it("reports an empty marker present even though it resolves zero files", () => {
    const empty = "<!-- workbench:memory-seed= -->";
    expect(hasSeedMarker(empty)).toBe(true);
    expect(parseSeedMarker(empty)).toEqual([]);
  });
});

describe("buildSeedMarker (CL-1952)", () => {
  it("emits a parseable HTML-comment sentinel listing the file names", () => {
    const marker = buildSeedMarker(PERSONAL_AGENT_SEED_FILES);
    expect(marker).toContain("workbench:memory-seed=");
    for (const name of EXPECTED_FILES) {
      expect(marker).toContain(name);
    }
  });
});
