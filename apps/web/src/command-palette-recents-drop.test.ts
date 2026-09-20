// Keeper for the standalone-chats removal: an `entity:agents:*` recent left
// in storage must never render (and so can never be selected —
// `handleSelect` in the provider has no `entity:agents:` branch, only the
// prefixes `isKnownRecentId` accepts). The store seed below goes through the
// real per-bench store and the real group builder; the filter expression is
// the same one `CommandPaletteProvider` runs on load.

import { afterEach, describe, expect, test } from "bun:test";

import { buildCommandPaletteGroups } from "./command-palette";
import { recentsStoreForBench } from "./command-palette-recents";
import { isKnownRecentId } from "./command-palette-provider";

const TENANT_ID = "tnt_recents_drop";
const STORAGE_KEY = `workbench.cmdk-recents:${TENANT_ID}`;

afterEach(() => {
  window.localStorage.removeItem(STORAGE_KEY);
});

describe("palette recents-drop", () => {
  test("drops legacy entity:agents ids while keeping every live prefix", () => {
    expect(isKnownRecentId("entity:agents:agt_1")).toBe(false);
    for (const id of [
      "route:/library",
      "action:new-workbench",
      "entity:workbenches:wb_1",
      "entity:routines:def_1",
      "entity:skills:research",
      "entity:library:art_1",
    ]) {
      expect(isKnownRecentId(id)).toBe(true);
    }
  });

  test("a seeded legacy entry never reaches the rendered recents", () => {
    const store = recentsStoreForBench(TENANT_ID);
    store.push({ kind: "agents", id: "entity:agents:agt_1", title: "Old Chat Agent" });
    store.push({
      kind: "workbenches",
      id: "entity:workbenches:wb_1",
      title: "Launch Planning",
      subtitle: "Workbench",
    });

    // The exact load expression in `CommandPaletteProvider`.
    const loaded = store.load().filter((entry) => isKnownRecentId(entry.id));
    expect(loaded.map((entry) => entry.id)).toEqual(["entity:workbenches:wb_1"]);

    // The exact recent mapping the provider feeds the group builder.
    const groups = buildCommandPaletteGroups({
      query: "",
      recents: loaded.map((entry) =>
        entry.subtitle === undefined
          ? { id: entry.id, title: entry.title }
          : { id: entry.id, title: entry.title, subtitle: entry.subtitle },
      ),
      sources: [],
    });
    const rendered = groups.flatMap((group) => group.items.map((item) => item.id));
    expect(rendered).toEqual(["entity:workbenches:wb_1"]);
    expect(rendered.some((id) => id.startsWith("entity:agents:"))).toBe(false);
  });
});
