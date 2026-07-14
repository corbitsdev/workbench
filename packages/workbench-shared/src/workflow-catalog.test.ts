import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import {
  WorkflowCatalogEntrySchema,
  orderCatalogEntries,
  type WorkflowCatalogEntry,
} from "./index";

function entry(
  kind: string,
  label: string,
  isFavorite = false,
): WorkflowCatalogEntry {
  return {
    kind,
    label,
    isFavorite,
    stepCount: 0,
    pauseCount: 0,
    steps: [],
    attachable: false,
  };
}

describe("orderCatalogEntries", () => {
  test("pins favorites first in favorites order, then the rest by label", () => {
    const entries = [
      entry("zeta", "Zeta"),
      entry("alpha", "Alpha"),
      entry("mid", "Mid", true),
      entry("beta", "Beta", true),
    ];
    const ordered = orderCatalogEntries(entries, ["beta", "mid"]);
    expect(ordered.map((e) => e.kind)).toEqual([
      "beta",
      "mid",
      "alpha",
      "zeta",
    ]);
  });

  test("orders purely by label when there are no favorites", () => {
    const ordered = orderCatalogEntries(
      [entry("b", "Beta"), entry("a", "Alpha")],
      [],
    );
    expect(ordered.map((e) => e.kind)).toEqual(["a", "b"]);
  });

  test("ignores favorite kinds that are not in the catalog", () => {
    const ordered = orderCatalogEntries([entry("a", "Alpha")], ["ghost", "a"]);
    expect(ordered.map((e) => e.kind)).toEqual(["a"]);
  });
});

describe("WorkflowCatalogEntrySchema", () => {
  test("rejects a step with an unknown classification", () => {
    const parsed = WorkflowCatalogEntrySchema({
      kind: "x",
      label: "X",
      isFavorite: false,
      stepCount: 1,
      pauseCount: 0,
      steps: [{ id: "s1", title: "Do", kind: "magic" }],
    });
    expect(parsed instanceof type.errors).toBe(true);
  });

  test("accepts a fully classified entry", () => {
    const parsed = WorkflowCatalogEntrySchema({
      kind: "x",
      label: "X",
      isFavorite: true,
      stepCount: 2,
      pauseCount: 1,
      attachable: true,
      steps: [
        { id: "s1", title: "Fetch", kind: "auto" },
        { id: "s2", title: "Approve", kind: "human" },
      ],
    });
    expect(parsed instanceof type.errors).toBe(false);
  });
});
