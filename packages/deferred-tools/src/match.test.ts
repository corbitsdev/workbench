import { describe, expect, it } from "bun:test";
import { matchesNamePattern, selectByPatterns } from "./match";

describe("matchesNamePattern", () => {
  it("matches a plain literal pattern exactly", () => {
    expect(matchesNamePattern("memory_write", "memory_write")).toBe(true);
    expect(matchesNamePattern("memory_write", "memory_read")).toBe(false);
  });

  it("treats `*` as any run of characters", () => {
    expect(matchesNamePattern("memory_write", "memory_*")).toBe(true);
    expect(matchesNamePattern("memory_read", "memory_*")).toBe(true);
    expect(matchesNamePattern("memory", "memory_*")).toBe(false);
  });

  // Red/green regression: the old implementation dropped `*` and spread `.*`
  // between every character, so `exa.*` matched names with no dot at all.
  it("does not match `exa.*` against a name lacking a literal dot", () => {
    expect(matchesNamePattern("exasearch", "exa.*")).toBe(false);
  });

  it("matches `exa.*` against a dotted name", () => {
    expect(matchesNamePattern("exa.search", "exa.*")).toBe(true);
  });

  // Red/green regression: the old implementation matched `memory_*` against
  // any name containing `memory_`, even with a leading prefix.
  it("anchors `memory_*` at the start of the name", () => {
    expect(matchesNamePattern("xxxmemory_write", "memory_*")).toBe(false);
    expect(matchesNamePattern("memory_write", "memory_*")).toBe(true);
  });

  it("handles a leading `*`", () => {
    expect(matchesNamePattern("_note", "*_note")).toBe(true);
    expect(matchesNamePattern("take_note", "*_note")).toBe(true);
    expect(matchesNamePattern("_note_extra", "*_note")).toBe(false);
  });

  it("handles a trailing `*`", () => {
    expect(matchesNamePattern("memory", "memory_*")).toBe(false);
    expect(matchesNamePattern("memory_write", "memory_*")).toBe(true);
  });

  it("handles multiple `*`s", () => {
    expect(matchesNamePattern("a_mid_b", "*_mid_*")).toBe(true);
    expect(matchesNamePattern("_mid_", "*_mid_*")).toBe(true);
    expect(matchesNamePattern("amidb", "*_mid_*")).toBe(false);
  });

  it("escapes regex metacharacters other than `*`", () => {
    // A literal dot in the pattern must not be over-widened by the wildcard.
    expect(matchesNamePattern("a.b", "a.b")).toBe(true);
    expect(matchesNamePattern("ab", "a.b")).toBe(false);
    expect(matchesNamePattern("aXb", "a.b")).toBe(false);
  });
});

describe("selectByPatterns", () => {
  it("selects definitions matching any of the patterns", () => {
    const definitions = [
      { name: "memory_write", description: "", inputSchema: {} },
      { name: "memory_read", description: "", inputSchema: {} },
      { name: "exa.search", description: "", inputSchema: {} },
      { name: "unrelated", description: "", inputSchema: {} },
    ];
    const selected = selectByPatterns(definitions, ["memory_*", "exa.*"]);
    expect(selected.map((d) => d.name)).toEqual(["memory_write", "memory_read", "exa.search"]);
  });

  it("does not select non-matching names (no dot for `exa.*`)", () => {
    const definitions = [
      { name: "exasearch", description: "", inputSchema: {} },
      { name: "exa.search", description: "", inputSchema: {} },
      { name: "memory_write", description: "", inputSchema: {} },
    ];
    const selected = selectByPatterns(definitions, ["exa.*"]);
    expect(selected.map((d) => d.name)).toEqual(["exa.search"]);
  });
});
