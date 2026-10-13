import { describe, expect, test } from "bun:test";

import { buildCommandPaletteGroups, type PaletteSource } from "./command-groups";

const workflows = { id: "route:/workflows", title: "Workflows" };
const settings = { id: "route:/settings", title: "Settings" };
const pages: PaletteSource = {
  id: "pages",
  heading: "Pages",
  kind: "pages",
  items: [workflows, settings],
};

describe("buildCommandPaletteGroups", () => {
  test("keeps Recent first and omits later duplicates without reordering other results", () => {
    const groups = buildCommandPaletteGroups({
      query: "",
      recents: [workflows],
      sources: [pages, { id: "duplicates", heading: "Duplicates", items: [workflows, settings] }],
    });

    expect(groups).toEqual([
      { id: "recents", heading: "Recent", items: [workflows] },
      { id: "pages", heading: "Pages", items: [settings] },
    ]);
  });

  test("deduplicates scoped results after excluding Recent and out-of-scope sources", () => {
    const workbench = { id: "entity:workbenches:one", title: "One" };
    const groups = buildCommandPaletteGroups({
      query: "#",
      recents: [workbench],
      sources: [
        { id: "unscoped", heading: "Unscoped", items: [workbench] },
        { id: "pages", heading: "Pages", kind: "pages", items: [workbench] },
        {
          id: "workbenches",
          heading: "Workbenches",
          kind: "workbenches",
          items: [workbench],
        },
        {
          id: "duplicates",
          heading: "Duplicates",
          kind: "workbenches",
          items: [workbench],
        },
      ],
    });

    expect(groups).toEqual([{ id: "workbenches", heading: "Workbenches", items: [workbench] }]);
  });

  test("keeps the first matching result even when an earlier copy does not match", () => {
    const groups = buildCommandPaletteGroups({
      query: "work",
      recents: [workflows],
      sources: [
        {
          id: "nonmatching",
          heading: "Nonmatching",
          items: [{ id: workflows.id, title: "Other" }],
        },
        pages,
        { id: "duplicates", heading: "Duplicates", items: [workflows] },
      ],
    });

    expect(groups).toEqual([{ id: "pages", heading: "Pages", items: [workflows] }]);
  });
});
