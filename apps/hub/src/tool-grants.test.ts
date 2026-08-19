// CL-6149: proves the hub's `toolGrantsForPins` port turns a launch's
// `toolPackagePins` into the exact `tool:<qualifiedId>` grants the
// workflow child's authz gate matches against — see
// `@corbits/folded-runs`' `deployAtHead`, which mints these into
// `config.grants`.
import { describe, expect, test } from "bun:test";
import { createToolGrantsForPins } from "./tool-grants";

const DESCRIPTIONS = [
  {
    name: "@corbits/routines-tools",
    version: "0.0.1",
    tools: [
      {
        qualifiedId: "@corbits/routines-tools/routines:routine_create",
        approval: "ask" as const,
      },
      {
        qualifiedId: "@corbits/routines-tools/routines:routine_list",
      },
    ],
  },
  {
    name: "@corbits/memory-tools",
    version: "0.0.1",
    tools: [{ qualifiedId: "@corbits/memory-tools/memory:memory_add" }],
  },
];

describe("createToolGrantsForPins", () => {
  test("mints tool:<qualifiedId>/invoke for every tool a pinned package declares", () => {
    const toolGrantsForPins = createToolGrantsForPins(DESCRIPTIONS);
    const grants = toolGrantsForPins([
      { name: "@corbits/routines-tools", version: "^1" },
    ]);
    expect(grants).toEqual([
      {
        resource: "tool:@corbits/routines-tools/routines:routine_create",
        action: "invoke",
        effect: "ask",
      },
      {
        resource: "tool:@corbits/routines-tools/routines:routine_list",
        action: "invoke",
        effect: "allow",
      },
    ]);
  });

  test('floors an unmarked tool at allow and a `approval: "ask"` tool at ask', () => {
    const toolGrantsForPins = createToolGrantsForPins(DESCRIPTIONS);
    const grants = toolGrantsForPins([
      { name: "@corbits/routines-tools", version: "^1" },
    ]);
    expect(
      grants.find((g) => g.resource.endsWith("routine_create"))?.effect,
    ).toBe("ask");
    expect(
      grants.find((g) => g.resource.endsWith("routine_list"))?.effect,
    ).toBe("allow");
  });

  test("unions grants across every pinned package", () => {
    const toolGrantsForPins = createToolGrantsForPins(DESCRIPTIONS);
    const grants = toolGrantsForPins([
      { name: "@corbits/routines-tools", version: "^1" },
      { name: "@corbits/memory-tools", version: "^1" },
    ]);
    expect(grants.map((g) => `${g.resource}/${g.action}`)).toEqual([
      "tool:@corbits/routines-tools/routines:routine_create/invoke",
      "tool:@corbits/routines-tools/routines:routine_list/invoke",
      "tool:@corbits/memory-tools/memory:memory_add/invoke",
      "memory/add",
      "memory/search",
    ]);
  });

  // CL-6296: pinning `@corbits/memory-tools` migrated onto
  // `@corbits/memory`'s own `registerMemoryRoutes`, which gates every
  // route behind `requireGrant("memory", action)` — a check the old,
  // now-deleted `@corbits/memory-hub` surface never performed. Without
  // these, a run's synthetic principal (which carries only the
  // `tool:<qualifiedId>` grants above, never a tenant-owner wildcard)
  // would 403 on every memory call the moment it reached the plane.
  test("pinning @corbits/memory-tools also mints memory:add and memory:search", () => {
    const toolGrantsForPins = createToolGrantsForPins(DESCRIPTIONS);
    const grants = toolGrantsForPins([
      { name: "@corbits/memory-tools", version: "^1" },
    ]);
    expect(grants.filter((g) => g.resource === "memory")).toEqual([
      { resource: "memory", action: "add", effect: "allow" },
      { resource: "memory", action: "search", effect: "allow" },
    ]);
  });

  test("a pin naming a package the hub does not describe yields no grants, never throws", () => {
    const toolGrantsForPins = createToolGrantsForPins(DESCRIPTIONS);
    const grants = toolGrantsForPins([
      { name: "@corbits/unknown-tools", version: "^1" },
    ]);
    expect(grants).toEqual([]);
  });

  test("no pins yields no grants", () => {
    const toolGrantsForPins = createToolGrantsForPins(DESCRIPTIONS);
    expect(toolGrantsForPins([])).toEqual([]);
  });
});
