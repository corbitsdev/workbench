import { expect, test } from "bun:test";
import { CONNECTOR_REGISTRY } from "@workbench/connections/registry";
import { MCP_PRESETS } from "@workbench/connections/mcp-presets";

import {
  GTM_TEMPLATE,
  WORKBENCH_TEMPLATES,
  WORKFLOW_CATALOG,
  templateBlockAssetNames,
  workbenchTemplate,
  workflowCatalogEntry,
} from "../src/index";

test("every template's blocks are real catalog workflows", () => {
  const known = new Set(WORKFLOW_CATALOG.map((entry) => entry.assetName));
  for (const template of WORKBENCH_TEMPLATES) {
    for (const assetName of templateBlockAssetNames(template)) {
      expect(known).toContain(assetName);
    }
  }
});

test("every connector a template names is a real connector or MCP preset", () => {
  const known = new Set([
    ...Object.keys(CONNECTOR_REGISTRY),
    ...MCP_PRESETS.map((preset) => preset.slug),
  ]);
  for (const template of WORKBENCH_TEMPLATES) {
    for (const connector of [
      ...template.requiredConnections,
      ...template.optionalConnections,
    ]) {
      expect(known).toContain(connector);
    }
  }
});

test("a template never both requires and merely offers the same connector", () => {
  for (const template of WORKBENCH_TEMPLATES) {
    const required = new Set(template.requiredConnections);
    for (const optional of template.optionalConnections) {
      expect(required).not.toContain(optional);
    }
  }
});

test("only automatable blocks get put on a schedule", () => {
  for (const template of WORKBENCH_TEMPLATES) {
    for (const routine of template.routines) {
      expect(workflowCatalogEntry(routine.blockAssetName)?.automatable).toBe(
        true,
      );
    }
  }
});

test("the GTM template installs the four ported v1 workflows plus the call write-up backbone", () => {
  expect(workbenchTemplate("gtm")).toBe(GTM_TEMPLATE);
  expect(templateBlockAssetNames(GTM_TEMPLATE)).toEqual([
    "granola-call",
    "process-granola-call",
    "attio-task-agent",
    "exa-topic-watch",
    "pain-point-collateral",
  ]);
});

test("the GTM template blocks the create on the two connectors nothing works without", () => {
  expect(GTM_TEMPLATE.requiredConnections).toEqual(["attio", "exa"]);
  expect(GTM_TEMPLATE.optionalConnections).toEqual(["granola"]);
});

test("the GTM template schedules call discovery and the web watch, and nothing else", () => {
  expect(GTM_TEMPLATE.routines.map((routine) => routine.key)).toEqual([
    "call-discovery",
    "topic-watch",
  ]);
  expect(
    GTM_TEMPLATE.routines.map((routine) => routine.blockAssetName),
  ).toEqual(["granola-call", "exa-topic-watch"]);
});

test("the watch's one open input reaches the routine that needs it", () => {
  expect(GTM_TEMPLATE.openInputs).toHaveLength(1);
  const [topic] = GTM_TEMPLATE.openInputs;
  expect(topic?.key).toBe("topic");
  expect(topic?.required).toBe(true);
  expect(topic?.appliesToRoutine).toBe("topic-watch");
});

test("every open input names a field the block's own trigger contract carries", () => {
  for (const template of WORKBENCH_TEMPLATES) {
    for (const input of template.openInputs) {
      const routine = template.routines.find(
        (candidate) => candidate.key === input.appliesToRoutine,
      );
      const fields =
        workflowCatalogEntry(routine?.blockAssetName ?? "")?.triggerFields ??
        [];
      expect(fields.map((field) => field.key)).toContain(input.key);
    }
  }
});

test("participants are addressable by a distinct handle", () => {
  for (const template of WORKBENCH_TEMPLATES) {
    const handles = template.participants.map(
      (participant) => participant.handle,
    );
    expect(new Set(handles).size).toBe(handles.length);
  }
});
