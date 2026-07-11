import { describe, expect, it } from "bun:test";
import { unwrapArgsEnvelope } from "./tool-args";

describe("unwrapArgsEnvelope", () => {
  it("unwraps a single object-valued envelope key when required keys are missing at top level", () => {
    const args = {
      artifact: { title: "T", kind: "note", content: "hello" },
    };
    expect(unwrapArgsEnvelope(args, ["title", "kind", "content"])).toEqual({
      title: "T",
      kind: "note",
      content: "hello",
    });
  });

  it("unwraps each recognized envelope key", () => {
    for (const key of ["artifact", "input", "args", "params"]) {
      const args = { [key]: { title: "T" } };
      expect(unwrapArgsEnvelope(args, ["title"])).toEqual({ title: "T" });
    }
  });

  it("keeps sibling top-level keys, letting the envelope win conflicts", () => {
    const args = {
      input: { title: "Inner", kind: "note" },
      jobLabel: "Label",
      title: 42,
    };
    expect(unwrapArgsEnvelope(args, ["title", "kind"])).toEqual({
      title: "Inner",
      kind: "note",
      jobLabel: "Label",
    });
  });

  it("returns flat args unchanged when all required keys are present", () => {
    const args = {
      title: "T",
      kind: "note",
      content: "c",
      artifact: { title: "nested" },
    };
    expect(unwrapArgsEnvelope(args, ["title", "kind", "content"])).toBe(args);
  });

  it("does not unwrap when more than one envelope key is object-valued", () => {
    const args = {
      input: { title: "A" },
      params: { title: "B" },
    };
    expect(unwrapArgsEnvelope(args, ["title"])).toBe(args);
  });

  it("does not unwrap non-object envelope values (string, array, null)", () => {
    for (const value of ["str", ["a"], null]) {
      const args = { input: value };
      expect(unwrapArgsEnvelope(args, ["title"])).toBe(args);
    }
  });

  it("does not unwrap when no envelope key is present", () => {
    const args = { other: { title: "T" } };
    expect(unwrapArgsEnvelope(args, ["title"])).toBe(args);
  });
});
