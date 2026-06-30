import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "arktype";
import {
  EmbeddedWorkflowDefSchema,
  definitionFingerprint,
  embeddedWorkflowDefsDir,
} from "./workflow-defs-embedded";

describe("definitionFingerprint", () => {
  it("is insensitive to object key order", () => {
    const a = { id: "k", steps: { s: { after: ["x"], kind: "step" } } };
    const b = { steps: { s: { kind: "step", after: ["x"] } }, id: "k" };
    expect(definitionFingerprint(a)).toBe(definitionFingerprint(b));
  });

  it("changes when a value changes", () => {
    const a = { id: "k", stepOrder: ["a", "b"] };
    const b = { id: "k", stepOrder: ["a", "c"] };
    expect(definitionFingerprint(a)).not.toBe(definitionFingerprint(b));
  });
});

describe("committed workflow defs (build gate)", () => {
  it("every generated def parses and carries a non-empty stepOrder", async () => {
    const dir = embeddedWorkflowDefsDir();
    const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const parsed = EmbeddedWorkflowDefSchema(
        JSON.parse(await readFile(join(dir, file), "utf8")),
      );
      if (parsed instanceof type.errors) {
        throw new Error(`${file} failed schema: ${parsed.summary}`);
      }
      expect(parsed.kind.length).toBeGreaterThan(0);
      expect(parsed.definition.stepOrder.length).toBeGreaterThan(0);
    }
  });

  it("rejects a def missing the definition envelope", () => {
    const bad = EmbeddedWorkflowDefSchema({ kind: "k", version: "0.1.0" });
    expect(bad instanceof type.errors).toBe(true);
  });
});
