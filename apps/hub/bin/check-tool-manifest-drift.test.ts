import { describe, expect, test } from "bun:test";
import type { ToolFactoryManifest } from "@workbench/tool-manifest";
import {
  findToolManifestDrift,
  renderDriftReport,
} from "./check-tool-manifest-drift";

const SAMPLE: ToolFactoryManifest[] = [
  {
    factoryId: "@workbench/tools-example/example",
    provider: null,
    tools: [
      {
        name: "example_tool",
        description: "An example tool for drift-check tests.",
        sideEffect: "read",
      },
    ],
  },
];

describe("findToolManifestDrift", () => {
  test("reports no drift when committed matches live", () => {
    const result = findToolManifestDrift(SAMPLE, SAMPLE);
    expect(result.hasDrift).toBe(false);
  });

  test("reports drift when the committed index is missing a live factory tool", () => {
    const live: ToolFactoryManifest[] = [
      {
        ...SAMPLE[0]!,
        tools: [
          ...SAMPLE[0]!.tools,
          {
            name: "example_tool_two",
            description: "A second example tool added upstream.",
            sideEffect: "read",
          },
        ],
      },
    ];
    const result = findToolManifestDrift(live, SAMPLE);
    expect(result.hasDrift).toBe(true);
    const report = renderDriftReport(result);
    expect(report).toContain("bun run build:tool-manifests");
  });
});

describe("check-tool-manifest-drift script against the real repo", () => {
  test("detects the current committed index is stale against live package manifests", async () => {
    const { collectToolFactoryManifests } = await import(
      "./build-tool-manifests"
    );
    const { loadCommittedToolManifestFactories, sortFactoryManifests } =
      await import("@workbench/tool-manifest");
    const live = sortFactoryManifests(await collectToolFactoryManifests());
    const committed = loadCommittedToolManifestFactories();
    const result = findToolManifestDrift(live, committed);
    // This is the live regression check: once the build order is fixed and
    // the committed index is regenerated, this must report no drift. Until
    // then it documents the exact bug this ticket fixes.
    expect(result.hasDrift).toBe(false);
  });
});
