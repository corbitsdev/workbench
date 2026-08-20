import { describe, expect, test } from "bun:test";
import { WIRE_CAPABILITIES } from "@intx/types";

import { CONCEPTS, CONCEPT_IDS, conceptById, DEFAULT_MIX } from "./concepts";

const vocabulary = new Set<string>(WIRE_CAPABILITIES);

describe("CONCEPTS", () => {
  test("every required and preferred capability is in the platform vocabulary", () => {
    for (const concept of CONCEPTS) {
      for (const capability of [...concept.requires, ...concept.prefers]) {
        expect({
          concept: concept.id,
          capability,
          real: vocabulary.has(capability),
        }).toEqual({
          concept: concept.id,
          capability,
          real: true,
        });
      }
    }
  });

  test("ids are unique and kebab-case", () => {
    expect(new Set(CONCEPT_IDS).size).toBe(CONCEPTS.length);
    for (const id of CONCEPT_IDS) expect(id).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  test("every concept requires at least one capability", () => {
    for (const concept of CONCEPTS) {
      expect(concept.requires.length).toBeGreaterThan(0);
    }
  });

  test("ceilings and reference mixes are positive", () => {
    for (const concept of CONCEPTS) {
      expect(concept.ceiling.maxInputUsdPerMTok).toBeGreaterThan(0);
      expect(concept.ceiling.maxOutputUsdPerMTok).toBeGreaterThan(0);
      expect(concept.referenceMix.inputMTok).toBeGreaterThan(0);
      expect(concept.referenceMix.outputMTok).toBeGreaterThan(0);
    }
  });

  test("every concept says when to use it, in one plain sentence", () => {
    for (const concept of CONCEPTS) {
      expect(concept.whenToUse.length).toBeGreaterThan(10);
      expect(concept.whenToUse.endsWith(".")).toBe(true);
    }
  });

  test("code-work prefers code execution rather than requiring it", () => {
    const codeWork = conceptById("code-work");
    expect(codeWork?.prefers).toContain("code-execution");
    expect(codeWork?.requires).not.toContain("code-execution");
  });

  test("conceptById returns undefined for a name nobody shipped", () => {
    expect(conceptById("vibes-based")).toBeUndefined();
  });

  test("the default mix is input-heavy", () => {
    expect(DEFAULT_MIX.inputMTok).toBeGreaterThan(DEFAULT_MIX.outputMTok);
  });
});
