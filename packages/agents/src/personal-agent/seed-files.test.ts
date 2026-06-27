/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import { buildPersonalAgentSystemPrompt } from "./prompt";
import {
  PERSONAL_AGENT_SEED_FILES,
  RETIRED_SEED_FILES,
  buildSeedMarker,
  parseSeedMarker,
  resolveSeedMarker,
  stripSeedMarker,
  hasSeedMarker,
} from "./seed-files";

describe("PERSONAL_AGENT_SEED_FILES (CL-2413)", () => {
  // Durable memory moved off the filesystem to the hub artifact store, reached
  // via the memory tools — so Myra seeds no workspace files.
  it("seeds no files", () => {
    expect(PERSONAL_AGENT_SEED_FILES).toEqual([]);
  });

  // A name that is both registered and retired would be classified `retired`
  // (silent) by parseSeedMarker and never seeded — a future footgun if someone
  // re-adds a previously-retired file to the table. Enforce the invariant.
  it("never lists a path that is also in RETIRED_SEED_FILES", () => {
    const collisions = PERSONAL_AGENT_SEED_FILES.filter((file) =>
      RETIRED_SEED_FILES.has(file.path),
    ).map((file) => file.path);
    expect(collisions).toEqual([]);
  });
});

describe("personal-agent prompt no longer carries a seed marker (CL-2413)", () => {
  it.each([true, false])(
    "the live prompt has no marker and resolves no seed files (xml=%s)",
    (xml) => {
      const prompt = buildPersonalAgentSystemPrompt("Myra", { xml });
      expect(hasSeedMarker(prompt)).toBe(false);
      expect(parseSeedMarker(prompt)).toEqual({
        files: [],
        skipped: [],
        retired: [],
      });
    },
  );
});

// The marker/parser machinery is retained as generic harness infrastructure
// (the sidecar still imports it). It must keep degrading gracefully on an OLD
// persisted prompt that still names since-retired files — now including
// MEMORY.md itself, which is no longer registered (CL-2364, CL-2413).
describe("parseSeedMarker degrades gracefully on legacy markers", () => {
  it("returns no files for a prompt with no marker", () => {
    expect(parseSeedMarker("some other agent prompt with no marker")).toEqual({
      files: [],
      skipped: [],
      retired: [],
    });
  });

  it("classifies a legacy MEMORY.md as retired (silent) and an unknown name as skipped, seeding nothing", () => {
    const legacy = "<!-- workbench:memory-seed=MEMORY.md,CONTACTS.md -->";
    let result: ReturnType<typeof parseSeedMarker> | undefined;
    expect(() => {
      result = parseSeedMarker(`prelude\n\n${legacy}`);
    }).not.toThrow();
    expect(result?.files).toEqual([]);
    expect(result?.retired).toEqual(["MEMORY.md"]);
    expect(result?.skipped).toEqual(["CONTACTS.md"]);
  });

  it("classifies a marker naming only MEMORY.md as retired with nothing skipped (silent restore)", () => {
    const legacy = "<!-- workbench:memory-seed=MEMORY.md -->";
    expect(parseSeedMarker(`prelude\n\n${legacy}`)).toEqual({
      files: [],
      skipped: [],
      retired: ["MEMORY.md"],
    });
  });

  it("skips a non-basename entry (path traversal) instead of throwing", () => {
    const rogue = buildSeedMarker([{ path: "../../etc/passwd", content: "x" }]);
    let result: ReturnType<typeof parseSeedMarker> | undefined;
    expect(() => {
      result = parseSeedMarker(`prelude\n\n${rogue}`);
    }).not.toThrow();
    expect(result?.files).toEqual([]);
    expect(result?.skipped).toEqual(["../../etc/passwd"]);
    expect(result?.retired).toEqual([]);
  });
});

// `resolveSeedMarker.malformed` is the exact gate the harness warns on. This is
// the behavior CL-2509 changed (a retired-only marker must NOT warn), and the
// empty-marker case is the load-bearing one that MUST stay loud for genuine
// prompt-builder/table drift.
describe("resolveSeedMarker malformed gate (CL-2509)", () => {
  it("a marker naming only a retired file is NOT malformed (silent restore)", () => {
    const r = resolveSeedMarker(
      "p\n\n<!-- workbench:memory-seed=MEMORY.md -->",
    );
    expect(r.malformed).toBe(false);
    expect(r.retired).toEqual(["MEMORY.md"]);
    expect(r.skipped).toEqual([]);
  });

  it("a marker mixing a retired and an unknown file is not malformed but still surfaces the unknown via skipped", () => {
    const r = resolveSeedMarker(
      "p\n\n<!-- workbench:memory-seed=MEMORY.md,GONE.md -->",
    );
    expect(r.malformed).toBe(false);
    expect(r.skipped).toEqual(["GONE.md"]);
  });

  it("an empty marker IS malformed (the genuine-drift signal stays loud)", () => {
    const r = resolveSeedMarker("p\n\n<!-- workbench:memory-seed= -->");
    expect(r.malformed).toBe(true);
  });

  it("a prompt with no marker at all is not malformed", () => {
    expect(resolveSeedMarker("plain prompt, no marker").malformed).toBe(false);
  });
});

describe("stripSeedMarker (CL-1952)", () => {
  it("removes a marker so the model never sees the control-plane sentinel", () => {
    const body = "<role>do things</role>";
    const prompt = `${body}\n\n<!-- workbench:memory-seed=MEMORY.md -->`;
    const cleaned = stripSeedMarker(prompt);
    expect(cleaned).not.toContain("workbench:memory-seed");
    expect(cleaned).not.toContain("<!--");
    expect(cleaned).toBe(body);
  });

  it("is a no-op for a prompt with no marker", () => {
    expect(stripSeedMarker("plain prompt, no marker")).toBe(
      "plain prompt, no marker",
    );
  });

  it("leaves the live personal-agent prompt body intact (no marker to strip)", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", { xml: true });
    const cleaned = stripSeedMarker(prompt);
    expect(cleaned).toContain("You are Myra, Chief of Staff");
    expect(cleaned).toContain("<role>");
  });
});

describe("hasSeedMarker (CL-1952)", () => {
  it("detects a present marker and the absence of one", () => {
    expect(hasSeedMarker("<!-- workbench:memory-seed=MEMORY.md -->")).toBe(
      true,
    );
    expect(hasSeedMarker("no marker here")).toBe(false);
  });

  it("reports an empty marker present even though it resolves zero files", () => {
    const empty = "<!-- workbench:memory-seed= -->";
    expect(hasSeedMarker(empty)).toBe(true);
    expect(parseSeedMarker(empty)).toEqual({
      files: [],
      skipped: [],
      retired: [],
    });
  });
});

describe("buildSeedMarker (CL-1952)", () => {
  it("emits a parseable HTML-comment sentinel listing the file names", () => {
    const marker = buildSeedMarker([
      { path: "A.md", content: "# A\n" },
      { path: "B.md", content: "# B\n" },
    ]);
    expect(marker).toContain("workbench:memory-seed=A.md,B.md");
  });
});
