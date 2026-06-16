import { describe, expect, it } from "bun:test";
import {
  buildRef,
  MAX_SNAPSHOT_ELEMENTS,
  pruneSnapshot,
  type RawSnapshot,
} from "./snapshot";
import type { RawElement } from "./types";

function el(overrides: Partial<RawElement>): RawElement {
  return {
    tag: "button",
    role: null,
    name: "Click me",
    id: null,
    testId: null,
    nameAttr: null,
    ariaLabel: null,
    text: "Click me",
    path: "body > button:nth-of-type(1)",
    frame: null,
    visible: true,
    ...overrides,
  };
}

describe("buildRef", () => {
  it("prefers id", () => {
    expect(buildRef(el({ id: "submit", testId: "x", nameAttr: "y" }))).toBe(
      '[id="submit"]',
    );
  });

  it("falls back to data-testid", () => {
    expect(buildRef(el({ testId: "login-btn", nameAttr: "y" }))).toBe(
      '[data-testid="login-btn"]',
    );
  });

  it("falls back to a tag-qualified name attribute", () => {
    expect(buildRef(el({ tag: "input", nameAttr: "email" }))).toBe(
      'input[name="email"]',
    );
  });

  it("falls back to a tag-qualified aria-label", () => {
    expect(buildRef(el({ ariaLabel: "Close dialog" }))).toBe(
      'button[aria-label="Close dialog"]',
    );
  });

  it("falls back to the structural path", () => {
    expect(
      buildRef(el({ path: "body > div:nth-of-type(2) > a:nth-of-type(1)" })),
    ).toBe("body > div:nth-of-type(2) > a:nth-of-type(1)");
  });

  it("escapes quotes in attribute values", () => {
    expect(buildRef(el({ id: 'a"b' }))).toBe('[id="a\\"b"]');
  });
});

describe("pruneSnapshot", () => {
  it("drops invisible elements", () => {
    const raw: RawSnapshot = {
      elements: [el({ id: "a" }), el({ id: "b", visible: false })],
      iframeCount: 0,
    };
    const result = pruneSnapshot(raw, "https://example.com");
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]?.ref).toBe('[id="a"]');
  });

  it("demotes ambiguous refs to their unique path", () => {
    const raw: RawSnapshot = {
      elements: [
        el({
          tag: "input",
          nameAttr: "q",
          path: "body > form:nth-of-type(1) > input:nth-of-type(1)",
        }),
        el({
          tag: "input",
          nameAttr: "q",
          path: "body > form:nth-of-type(2) > input:nth-of-type(1)",
        }),
      ],
      iframeCount: 0,
    };
    const result = pruneSnapshot(raw, "https://example.com");
    expect(result.elements.map((e) => e.ref)).toEqual([
      "body > form:nth-of-type(1) > input:nth-of-type(1)",
      "body > form:nth-of-type(2) > input:nth-of-type(1)",
    ]);
  });

  it("makes colliding paths unique with an nth suffix", () => {
    const raw: RawSnapshot = {
      elements: [
        el({ id: null, name: "A", path: "body > button:nth-of-type(1)" }),
        el({ id: null, name: "B", path: "body > button:nth-of-type(1)" }),
      ],
      iframeCount: 0,
    };
    const refs = pruneSnapshot(raw, "https://x.com").elements.map((e) => e.ref);
    expect(new Set(refs).size).toBe(refs.length);
    expect(refs).toEqual([
      "body > button:nth-of-type(1) >> nth=0",
      "body > button:nth-of-type(1) >> nth=1",
    ]);
  });

  it("always emits unique refs even when a demoted path equals another ref", () => {
    const raw: RawSnapshot = {
      elements: [
        el({ id: "dup", path: "p1" }),
        el({ id: "dup", path: "p2" }),
        el({ id: null, name: "C", path: "p1" }),
      ],
      iframeCount: 0,
    };
    const refs = pruneSnapshot(raw, "https://x.com").elements.map((e) => e.ref);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it("frame-qualifies refs for elements inside an iframe", () => {
    const raw: RawSnapshot = {
      elements: [
        el({ id: "top", frame: null }),
        el({ id: "inner", frame: "iframe:nth-of-type(1)" }),
      ],
      iframeCount: 1,
    };
    const refs = pruneSnapshot(raw, "https://x.com").elements.map((e) => e.ref);
    expect(refs).toEqual([
      '[id="top"]',
      'iframe:nth-of-type(1) >>> [id="inner"]',
    ]);
  });

  it("dedupes per-frame so identical inner refs in different frames stay distinct", () => {
    const raw: RawSnapshot = {
      elements: [
        el({
          id: null,
          name: "A",
          path: "button:nth-of-type(1)",
          frame: "iframe:nth-of-type(1)",
        }),
        el({
          id: null,
          name: "B",
          path: "button:nth-of-type(1)",
          frame: "iframe:nth-of-type(2)",
        }),
      ],
      iframeCount: 2,
    };
    const refs = pruneSnapshot(raw, "https://x.com").elements.map((e) => e.ref);
    expect(new Set(refs).size).toBe(2);
    expect(refs).toEqual([
      "iframe:nth-of-type(1) >>> button:nth-of-type(1)",
      "iframe:nth-of-type(2) >>> button:nth-of-type(1)",
    ]);
  });

  it("caps the element list and flags truncation", () => {
    const elements = Array.from(
      { length: MAX_SNAPSHOT_ELEMENTS + 5 },
      (_unused, i) => el({ path: `body > button:nth-of-type(${i + 1})` }),
    );
    const result = pruneSnapshot(
      { elements, iframeCount: 0 },
      "https://example.com",
    );
    expect(result.elements).toHaveLength(MAX_SNAPSHOT_ELEMENTS);
    expect(result.truncated).toBe(true);
  });

  it("does not flag truncation under the cap", () => {
    const result = pruneSnapshot(
      { elements: [el({ id: "a" })], iframeCount: 2 },
      "https://x.com",
    );
    expect(result.truncated).toBe(false);
    expect(result.iframeCount).toBe(2);
  });

  it("defaults role to the tag and name to text", () => {
    const result = pruneSnapshot(
      {
        elements: [el({ id: "a", role: null, name: null, text: "Hi" })],
        iframeCount: 0,
      },
      "https://x.com",
    );
    expect(result.elements[0]).toEqual({
      ref: '[id="a"]',
      role: "button",
      name: "Hi",
    });
  });
});
