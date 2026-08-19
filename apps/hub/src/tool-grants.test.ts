// CL-6149: proves the hub's `toolGrantsForPins` port turns a launch's
// `toolPackagePins` into the exact `tool:<qualifiedId>` grants the
// workflow child's authz gate matches against — see
// `@corbits/folded-runs`' `deployAtHead`, which mints these into
// `config.grants`.
import { describe, expect, test } from "bun:test";
import {
  createHubGrantRequirementsForPins,
  createToolGrantsForPins,
} from "./tool-grants";

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
    ]);
  });

  // The wire plane carries `tool:<id>` / `invoke` and nothing else, for
  // every pin — `@corbits/memory-tools` included. What that package needs
  // from the hub's own memory routes is a different plane entirely
  // (`createHubGrantRequirementsForPins` below), resolved against the
  // invoker's authority and written as real grant rows at launch. Minting a
  // `memory`/`add` pair into the child's `grants.json` only ever looked
  // correct: the hub never reads that file, so the call still 403'd.
  test("pinning @corbits/memory-tools mints tool grants only — never a hub resource pair", () => {
    const toolGrantsForPins = createToolGrantsForPins(DESCRIPTIONS);
    const grants = toolGrantsForPins([
      { name: "@corbits/memory-tools", version: "^1" },
    ]);
    expect(grants.filter((g) => g.resource === "memory")).toEqual([]);
    expect(grants.every((g) => g.action === "invoke")).toBe(true);
    expect(grants.length).toBeGreaterThan(0);
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

// The other plane: what the hub honours once a pinned package's tool calls
// back into one of its own guarded routes. These never travel on the wire —
// `./run-hub-grants.ts` resolves each against the invoker's own authority
// and writes what survives as real `grant` rows.
describe("createHubGrantRequirementsForPins", () => {
  test("derives memory-tools' requirements from @corbits/memory's own declaration, so they cannot drift from what the routes check", () => {
    const requirementsForPins = createHubGrantRequirementsForPins();
    const requirements = requirementsForPins([
      { name: "@corbits/memory-tools", version: "^1" },
    ]);
    expect(requirements).toEqual([
      { resource: "memory", action: "add", effect: "allow" },
      { resource: "memory", action: "search", effect: "allow" },
    ]);
  });

  // `forget` and `purge` are declared for the `routes` surface only. A run
  // that pinned the tools must not pick up irreversible deletion just by
  // being in the same requirement list.
  test("never hands a tools pin the routes-only forget and purge authority", () => {
    const requirementsForPins = createHubGrantRequirementsForPins();
    const actions = requirementsForPins([
      { name: "@corbits/memory-tools", version: "^1" },
    ]).map((requirement) => requirement.action);
    expect(actions).not.toContain("forget");
    expect(actions).not.toContain("purge");
  });

  test("a pin that needs nothing from the hub's own routes declares nothing", () => {
    const requirementsForPins = createHubGrantRequirementsForPins();
    expect(
      requirementsForPins([{ name: "@corbits/routines-tools", version: "^1" }]),
    ).toEqual([]);
  });
});
