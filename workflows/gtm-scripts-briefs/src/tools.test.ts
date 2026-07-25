import { describe, expect, it } from "bun:test";
import { createGtmScriptsBriefsTools } from "./tools";
import { toolManifestFile } from "./tool-manifest";

const SIGNAL = new AbortController().signal;

function preparePersistTool() {
  const tool = createGtmScriptsBriefsTools().find(
    (t) => t.definition.name === "gtm_scripts_briefs_prepare_persist",
  );
  if (!tool || tool.kind !== "full") {
    throw new Error("prepare-persist tool not registered as a full tool");
  }
  return tool;
}

const BASE_ARGS = {
  topic: "AI SDRs",
  days: 30,
  reply: "Full deliverable text.",
  workflowKind: "gtm-scripts-briefs",
  artifactKind: "long-form-script-package",
  jobLabel: "GTM scripts and briefs",
};

describe("gtm_scripts_briefs_prepare_persist", () => {
  it("shapes required fields into write_artifact's argument shape", async () => {
    const tool = preparePersistTool();
    const result = await tool.handler(
      {
        id: "call_1",
        name: "gtm_scripts_briefs_prepare_persist",
        arguments: BASE_ARGS,
      },
      SIGNAL,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual({
      title: "AI SDRs",
      body: "Full deliverable text.",
      kind: "long-form-script-package",
      data: {
        workflowKind: "gtm-scripts-briefs",
        topic: "AI SDRs",
        days: 30,
        artifactKind: "long-form-script-package",
      },
      jobLabel: "GTM scripts and briefs",
    });
  });

  it("includes optional audience and objective when present", async () => {
    const tool = preparePersistTool();
    const result = await tool.handler(
      {
        id: "call_2",
        name: "gtm_scripts_briefs_prepare_persist",
        arguments: {
          ...BASE_ARGS,
          audience: "VP Sales",
          objective: "Educate on agent ROI",
        },
      },
      SIGNAL,
    );

    expect(result.content).toEqual({
      title: "AI SDRs",
      body: "Full deliverable text.",
      kind: "long-form-script-package",
      data: {
        workflowKind: "gtm-scripts-briefs",
        topic: "AI SDRs",
        days: 30,
        audience: "VP Sales",
        objective: "Educate on agent ROI",
        artifactKind: "long-form-script-package",
      },
      jobLabel: "GTM scripts and briefs",
    });
  });

  it("errors when topic is missing", async () => {
    const tool = preparePersistTool();
    const { topic: _topic, ...rest } = BASE_ARGS;
    const result = await tool.handler(
      {
        id: "call_3",
        name: "gtm_scripts_briefs_prepare_persist",
        arguments: rest,
      },
      SIGNAL,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe("topic is required");
  });

  it("errors when reply is blank", async () => {
    const tool = preparePersistTool();
    const result = await tool.handler(
      {
        id: "call_4",
        name: "gtm_scripts_briefs_prepare_persist",
        arguments: { ...BASE_ARGS, reply: "   " },
      },
      SIGNAL,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe("reply is required");
  });

  it("errors when days is not a number", async () => {
    const tool = preparePersistTool();
    const result = await tool.handler(
      {
        id: "call_5",
        name: "gtm_scripts_briefs_prepare_persist",
        arguments: { ...BASE_ARGS, days: "30" },
      },
      SIGNAL,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe("days is required");
  });

  it("errors when workflow constants are missing", async () => {
    const tool = preparePersistTool();
    const { jobLabel: _jobLabel, ...rest } = BASE_ARGS;
    const result = await tool.handler(
      {
        id: "call_6",
        name: "gtm_scripts_briefs_prepare_persist",
        arguments: rest,
      },
      SIGNAL,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      "workflowKind, artifactKind, and jobLabel are required",
    );
  });

  it("falls back to the _raw JSON envelope", async () => {
    const tool = preparePersistTool();
    const result = await tool.handler(
      {
        id: "call_7",
        name: "gtm_scripts_briefs_prepare_persist",
        arguments: { _raw: JSON.stringify(BASE_ARGS) },
      },
      SIGNAL,
    );

    expect(result.content).toMatchObject({ title: "AI SDRs" });
  });
});

describe("tool-manifest", () => {
  it("registers gtm_scripts_briefs_prepare_persist under the gtm-scripts-briefs factory", () => {
    const factory = toolManifestFile.factories[0];
    expect(factory?.factoryId).toBe("@workbench/tools-gtm-scripts-briefs/core");
    expect(factory?.bareToolNames).toEqual([
      "gtm_scripts_briefs_prepare_persist",
    ]);
  });
});
