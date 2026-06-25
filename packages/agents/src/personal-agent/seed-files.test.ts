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

describe("parseSeedMarker (CL-1952, CL-2364)", () => {
  it("returns the declared files with their stub content for the base deploy prompt", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", { xml: true });
    const { files, skipped } = parseSeedMarker(prompt);
    expect(files.map((f) => f.path).sort()).toEqual([...EXPECTED_FILES].sort());
    expect(skipped).toEqual([]);
    for (const file of files) {
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

    const { files } = parseSeedMarker(personalized);
    expect(files.map((f) => f.path).sort()).toEqual([...EXPECTED_FILES].sort());
  });

  it("mirrors the harness flow: parse off the base prompt, then strip before the model prompt is built", () => {
    // The harness parses the file list off the RAW base prompt, strips the
    // marker, THEN appends active context. The marker and active-context block
    // never coexist in the prompt the model sees, so this models that ordering.
    const base = buildPersonalAgentSystemPrompt("Myra", { xml: false });
    const { files } = parseSeedMarker(base);
    expect(files.map((f) => f.path).sort()).toEqual([...EXPECTED_FILES].sort());

    const modelPrompt = `${stripSeedMarker(base)}\n\n## Active Context\nCurrent date: 15/06/2026`;
    expect(modelPrompt).not.toContain("workbench:memory-seed");
  });

  it("returns no files for a prompt with no marker (non-personal agent)", () => {
    expect(parseSeedMarker("some other agent prompt with no marker")).toEqual({
      files: [],
      skipped: [],
    });
  });

  // CL-2364: a since-folded seed file named in an OLD persisted prompt must be
  // skipped-and-reported, never thrown — otherwise a sidecar restart that
  // restores from the stale prompt wedges the whole live session.
  it("skips an unregistered basename and reports it, seeding only the known files", () => {
    const legacy =
      "<!-- workbench:memory-seed=MEMORY.md,CONTACTS.md,GONE.md -->";
    let result: ReturnType<typeof parseSeedMarker> | undefined;
    expect(() => {
      result = parseSeedMarker(`prelude\n\n${legacy}`);
    }).not.toThrow();
    expect(result?.files.map((f) => f.path)).toEqual(["MEMORY.md"]);
    expect(result?.skipped.sort()).toEqual(["CONTACTS.md", "GONE.md"]);
  });

  it.each([
    "CONTACTS.md",
    "ERRORS.md",
    "HUMAN.md",
    "PENDING.md",
    "SCRATCHPAD.md",
  ])("skips the folded-away %s without throwing and reports it", (folded) => {
    const legacy = `<!-- workbench:memory-seed=MEMORY.md,${folded} -->`;
    let result: ReturnType<typeof parseSeedMarker> | undefined;
    expect(() => {
      result = parseSeedMarker(`prelude\n\n${legacy}`);
    }).not.toThrow();
    expect(result?.files.map((f) => f.path)).toEqual(["MEMORY.md"]);
    expect(result?.skipped).toEqual([folded]);
  });

  it("does not throw on a rogue marker naming a file with no registered stub", () => {
    const rogue = buildSeedMarker([
      { path: "UNKNOWN.md", content: "# Unknown\n" },
    ]);
    let result: ReturnType<typeof parseSeedMarker> | undefined;
    expect(() => {
      result = parseSeedMarker(`prelude\n\n${rogue}`);
    }).not.toThrow();
    expect(result?.files).toEqual([]);
    expect(result?.skipped).toEqual(["UNKNOWN.md"]);
  });

  it("skips a non-basename entry (path traversal) instead of throwing", () => {
    const rogue = buildSeedMarker([{ path: "../../etc/passwd", content: "x" }]);
    let result: ReturnType<typeof parseSeedMarker> | undefined;
    expect(() => {
      result = parseSeedMarker(`prelude\n\n${rogue}`);
    }).not.toThrow();
    expect(result?.files).toEqual([]);
    expect(result?.skipped).toEqual(["../../etc/passwd"]);
  });
});

// CL-2364: the hard "marker matches table" contract moves here, to BUILD TIME.
// The live personal-agent prompt's marker must name only registered basenames,
// so genuine prompt/table drift fails in CI — not on a prod session restore.
describe("seed-marker drift contract (CL-2364)", () => {
  const registered = new Set(PERSONAL_AGENT_SEED_FILES.map((f) => f.path));

  it.each([true, false])(
    "the live prompt marker names only registered basenames (xml=%s)",
    (xml) => {
      const prompt = buildPersonalAgentSystemPrompt("Myra", { xml });
      const { files, skipped } = parseSeedMarker(prompt);
      expect(skipped).toEqual([]);
      for (const file of files) {
        expect(registered.has(file.path)).toBe(true);
      }
    },
  );
});

describe("stripSeedMarker (CL-1952)", () => {
  it("removes the marker so the model never sees the control-plane sentinel", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", { xml: true });
    // The base prompt carries the marker; parsing must still resolve all files.
    expect(
      parseSeedMarker(prompt)
        .files.map((f) => f.path)
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
        .files.map((f) => f.path)
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
    expect(parseSeedMarker(empty)).toEqual({ files: [], skipped: [] });
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
