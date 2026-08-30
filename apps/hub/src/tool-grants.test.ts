// CL-6149: proves the hub's `toolGrantsForPins` port turns a launch's
// `toolPackagePins` into the exact `tool:<qualifiedId>` grants the
// workflow child's authz gate matches against — see
// `@corbits/folded-runs`' `deployAtHead`, which mints these into
// `config.grants`.
import { describe, expect, test } from "bun:test";
import { describeCorbitsToolPackages } from "@corbits/tool-registry-publish";
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
    expect(grants.map((g) => g.resource)).toEqual([
      "tool:@corbits/routines-tools/routines:routine_create",
      "tool:@corbits/routines-tools/routines:routine_list",
      "tool:@corbits/memory-tools/memory:memory_add",
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

  test("assistant pin of webhook_create is ask, not allow", async () => {
    const toolGrantsForPins = createToolGrantsForPins(
      await describeCorbitsToolPackages(),
    );
    const grants = toolGrantsForPins([
      { name: "@corbits/manus-tools", version: "*" },
    ]);
    expect(
      grants.find((g) => g.resource.endsWith(":webhook_create"))?.effect,
    ).toBe("ask");
    expect(
      grants.find((g) => g.resource.endsWith(":create_slides"))?.effect,
    ).toBe("allow");
    expect(grants.find((g) => g.resource.endsWith(":task_list"))?.effect).toBe(
      "allow",
    );
  });
});
