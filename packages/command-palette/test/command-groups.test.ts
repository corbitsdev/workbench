import { describe, expect, test } from "bun:test";

import {
  buildCommandPaletteGroups,
  type PaletteSource,
} from "../src/command-groups";

const actions: PaletteSource = {
  id: "actions",
  heading: "Commands",
  kind: "actions",
  items: [{ id: "action:theme", title: "Toggle theme" }],
};

const workbenches: PaletteSource = {
  id: "workbenches",
  heading: "Workbenches",
  kind: "workbenches",
  items: [
    { id: "ch:eng", title: "Engineering" },
    { id: "ch:design", title: "Design" },
  ],
};

const pages: PaletteSource = {
  id: "pages",
  heading: "Pages",
  kind: "pages",
  items: [{ id: "route:/library", title: "Library" }],
};

const routines: PaletteSource = {
  id: "routines",
  heading: "Routines",
  items: [{ id: "rt:1", title: "Weekly digest" }],
};

const people: PaletteSource = {
  id: "people",
  heading: "People & agents",
  kind: "people",
  items: [{ id: "ppl:myra", title: "Myra" }],
};

const recents = [{ id: "ch:eng", title: "Engineering" }];

describe("buildCommandPaletteGroups", () => {
  test("empty unscoped query shows recents plus every source, in caller order", () => {
    const groups = buildCommandPaletteGroups({
      query: "",
      recents,
      sources: [actions, workbenches, pages, routines, people],
    });
    expect(groups.map((g) => g.id)).toEqual([
      "recents",
      "actions",
      "workbenches",
      "pages",
      "routines",
      "people",
    ]);
  });

  test("an unscoped source placed after scoped sources still renders after them — People & agents can sit last, matching the mock", () => {
    const groups = buildCommandPaletteGroups({
      query: "",
      recents: [],
      sources: [actions, workbenches, pages, routines, people],
    });
    expect(groups.at(-1)?.id).toBe("people");
  });

  test("recents are hidden once the query is non-empty", () => {
    const groups = buildCommandPaletteGroups({
      query: "eng",
      recents,
      sources: [workbenches],
    });
    expect(groups.find((g) => g.id === "recents")).toBeUndefined();
  });

  test("recents are hidden under an active scope even with an empty query", () => {
    const groups = buildCommandPaletteGroups({
      query: "#",
      recents,
      sources: [workbenches],
    });
    expect(groups.find((g) => g.id === "recents")).toBeUndefined();
  });

  test("a scope prefix keeps only the matching scoped source", () => {
    const groups = buildCommandPaletteGroups({
      query: "#",
      recents: [],
      sources: [actions, workbenches, pages, routines],
    });
    expect(groups.map((g) => g.id)).toEqual(["workbenches"]);
  });

  test("unscoped sources vanish once a scope is active", () => {
    const groups = buildCommandPaletteGroups({
      query: ">",
      recents: [],
      sources: [actions, routines],
    });
    expect(groups.map((g) => g.id)).toEqual(["actions"]);
  });

  test("query text filters items within a scope", () => {
    const groups = buildCommandPaletteGroups({
      query: "#des",
      recents: [],
      sources: [workbenches],
    });
    expect(groups).toEqual([
      {
        id: "workbenches",
        heading: "Workbenches",
        items: [{ id: "ch:design", title: "Design" }],
      },
    ]);
  });

  test("a group with no matches is omitted entirely", () => {
    const groups = buildCommandPaletteGroups({
      query: "zzz",
      recents: [],
      sources: [workbenches, routines],
    });
    expect(groups).toEqual([]);
  });

  test("an unscoped query with no prefix still filters unscoped sources by match text", () => {
    const groups = buildCommandPaletteGroups({
      query: "weekly",
      recents: [],
      sources: [workbenches, routines],
    });
    expect(groups).toEqual([
      {
        id: "routines",
        heading: "Routines",
        items: [{ id: "rt:1", title: "Weekly digest" }],
      },
    ]);
  });
});
