import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import {
  ComparisonResultSchema,
  parseComparisonResult,
} from "./comparison-schema";

const VALID = {
  ranking: [{ rank: 1, label: "A" }],
  variants: [{ label: "A", content: "ok" }],
};

describe("comparison-schema", () => {
  it("parses a valid decoded object", () => {
    expect(parseComparisonResult(VALID)?.variants[0]?.content).toBe("ok");
  });

  it("parses a valid JSON string as stored in artifact.content", () => {
    expect(parseComparisonResult(JSON.stringify(VALID))?.ranking[0]?.rank).toBe(
      1,
    );
  });

  it("returns null for nullish input and non-JSON strings", () => {
    expect(parseComparisonResult(undefined)).toBeNull();
    expect(parseComparisonResult(null)).toBeNull();
    expect(parseComparisonResult("{")).toBeNull();
  });

  it("rejects a top-level non-array variants field", () => {
    expect(
      parseComparisonResult({ ...VALID, variants: "not-an-array" }),
    ).toBeNull();
  });

  it("rejects a ranking entry whose rank is the wrong type", () => {
    expect(
      parseComparisonResult({ ...VALID, ranking: [{ rank: "1", label: "A" }] }),
    ).toBeNull();
  });

  it("rejects a ranking entry missing its required rank", () => {
    expect(
      parseComparisonResult({ ...VALID, ranking: [{ label: "A" }] }),
    ).toBeNull();
  });

  it("rejects a variant missing its required content", () => {
    expect(
      parseComparisonResult({ ...VALID, variants: [{ label: "A" }] }),
    ).toBeNull();
  });

  it("rejects a variant carrying an out-of-enum status", () => {
    expect(
      parseComparisonResult({
        ...VALID,
        variants: [{ label: "A", content: "ok", status: "bogus" }],
      }),
    ).toBeNull();
  });

  it("rejects an out-of-enum decidedBy", () => {
    expect(parseComparisonResult({ ...VALID, decidedBy: "robot" })).toBeNull();
  });

  it("surfaces type.errors from the schema for malformed nested data", () => {
    const parsed = ComparisonResultSchema({
      ...VALID,
      ranking: [{ rank: "1", label: "A" }],
    });
    expect(parsed instanceof type.errors).toBe(true);
  });

  // The package test harness preloads Happy DOM (see src/test-setup.ts), so
  // this process always has window/document — asserting DOM-independence here
  // would prove nothing. Prove Node-safety by importing and exercising the
  // module in a fresh process with NO DOM preload: --preload is a bun-test flag
  // that a spawned `bun -e` child does not inherit.
  it("imports and parses in a DOM-free process (Node-safe)", () => {
    const modulePath = `${import.meta.dir}/comparison-schema.ts`;
    const script = [
      `const { parseComparisonResult } = await import(${JSON.stringify(modulePath)});`,
      `if (typeof globalThis.document !== "undefined" || typeof globalThis.window !== "undefined") {`,
      `  console.error("DOM globals present in child"); process.exit(2);`,
      `}`,
      `const result = parseComparisonResult(${JSON.stringify(JSON.stringify(VALID))});`,
      `if (!result || result.variants[0]?.content !== "ok") {`,
      `  console.error("parse failed in DOM-free process"); process.exit(3);`,
      `}`,
    ].join("\n");
    const child = Bun.spawnSync(["bun", "-e", script]);
    // Exit code is the sole pass/fail signal: the child exits non-zero (with a
    // diagnostic on stderr) only on its own explicit failure branches. Do not
    // assert stderr is empty — an incidental Bun runtime notice would then fail
    // this test for a reason unrelated to Node-safety.
    expect(child.exitCode).toBe(0);
  });
});
