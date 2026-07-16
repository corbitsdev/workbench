import { describe, expect, test } from "bun:test";
import {
  STYLE_AXES,
  composeStyleOverlay,
  getStyleAxis,
  isStyleAxisOptionId,
  type StyleAxisSelections,
} from "./style-axes";

const FORBIDDEN_SUBSTRINGS = ["search_tools", "load_tools", "cannot", "disabled"];

describe("style-axes catalog", () => {
  test("every axis's default option composes to an empty snippet", () => {
    for (const axis of STYLE_AXES) {
      const defaultOption = axis.options.find(
        (o) => o.id === axis.defaultOptionId,
      );
      expect(defaultOption).toBeDefined();
      expect(defaultOption?.snippet).toBe("");
    }
  });

  test("no snippet contains a forbidden word or a search/load-tools contradiction", () => {
    for (const axis of STYLE_AXES) {
      for (const option of axis.options) {
        const lower = option.snippet.toLowerCase();
        for (const forbidden of FORBIDDEN_SUBSTRINGS) {
          expect(lower.includes(forbidden)).toBe(false);
        }
      }
    }
  });

  test("every non-default snippet is a curated 1-2 sentence imperative", () => {
    for (const axis of STYLE_AXES) {
      for (const option of axis.options) {
        if (option.id === axis.defaultOptionId) continue;
        expect(option.snippet.length).toBeGreaterThan(0);
        const sentenceCount = option.snippet
          .split(/[.!?](?:\s|$)/)
          .filter((s) => s.trim().length > 0).length;
        expect(sentenceCount).toBeLessThanOrEqual(2);
      }
    }
  });

  test("getStyleAxis and isStyleAxisOptionId resolve real ids", () => {
    expect(getStyleAxis("personality")?.id).toBe("personality");
    expect(isStyleAxisOptionId("emojiUse", "heavy")).toBe(true);
    expect(isStyleAxisOptionId("emojiUse", "not-a-real-option")).toBe(false);
  });
});

describe("composeStyleOverlay", () => {
  test("no selections compose to an empty string", () => {
    expect(composeStyleOverlay({})).toBe("");
  });

  test("every axis set to its default option composes to an empty string", () => {
    const selections: StyleAxisSelections = {};
    for (const axis of STYLE_AXES) {
      selections[axis.id] = axis.defaultOptionId;
    }
    expect(composeStyleOverlay(selections)).toBe("");
  });

  test("an unknown option id is ignored rather than throwing", () => {
    expect(composeStyleOverlay({ personality: "not-a-real-option" })).toBe(
      "",
    );
  });

  test("a single non-default selection composes exactly its snippet", () => {
    const overlay = composeStyleOverlay({ personality: "candid" });
    const candid = getStyleAxis("personality")?.options.find(
      (o) => o.id === "candid",
    );
    expect(overlay).toBe(candid?.snippet);
  });

  test("every axis set to a non-default option composes under 1200 chars", () => {
    const selections: StyleAxisSelections = {};
    for (const axis of STYLE_AXES) {
      const nonDefault = axis.options.find(
        (o) => o.id !== axis.defaultOptionId,
      );
      expect(nonDefault).toBeDefined();
      if (nonDefault) selections[axis.id] = nonDefault.id;
    }
    const overlay = composeStyleOverlay(selections);
    expect(overlay.length).toBeGreaterThan(0);
    expect(overlay.length).toBeLessThan(1200);
  });
});
