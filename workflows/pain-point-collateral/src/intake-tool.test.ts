import { expect, test } from "bun:test";
import type { BaseEnv } from "@intx/agent";

import {
  PAIN_POINT_COLLATERAL_INTAKE_TOOL,
  PAIN_POINT_COLLATERAL_INTAKE_TOOL_NAME,
} from "./intake-tool";

function testEnv(): BaseEnv {
  return {} as unknown as BaseEnv;
}

test("the tool is namespaced under this workflow package, not a shared one", () => {
  expect(PAIN_POINT_COLLATERAL_INTAKE_TOOL.id).toBe(
    "@corbits/workflow-pain-point-collateral/intake",
  );
});

test("the tool carries no approval gate — it only validates and normalizes intake", () => {
  expect(PAIN_POINT_COLLATERAL_INTAKE_TOOL.definitions).toEqual([
    { name: PAIN_POINT_COLLATERAL_INTAKE_TOOL_NAME },
  ]);
});

test("run reports the transcript source when a non-empty transcript is given", async () => {
  const bundle = PAIN_POINT_COLLATERAL_INTAKE_TOOL(testEnv());
  const result = await bundle.run(
    {
      id: "call_1",
      name: PAIN_POINT_COLLATERAL_INTAKE_TOOL_NAME,
      arguments: { transcript: "Customer said onboarding is too slow." },
    },
    new AbortController().signal,
  );
  expect(result.isError).toBe(false);
  expect(JSON.parse(String(result.content))).toEqual({
    source: "transcript",
    transcript: "Customer said onboarding is too slow.",
  });
});

test("run reports the noteId source when a non-empty noteId is given and no transcript is", async () => {
  const bundle = PAIN_POINT_COLLATERAL_INTAKE_TOOL(testEnv());
  const result = await bundle.run(
    {
      id: "call_1",
      name: PAIN_POINT_COLLATERAL_INTAKE_TOOL_NAME,
      arguments: { noteId: "note_123" },
    },
    new AbortController().signal,
  );
  expect(result.isError).toBe(false);
  expect(JSON.parse(String(result.content))).toEqual({
    source: "noteId",
    noteId: "note_123",
  });
});

test("run prefers transcript over noteId when both are given", async () => {
  const bundle = PAIN_POINT_COLLATERAL_INTAKE_TOOL(testEnv());
  const result = await bundle.run(
    {
      id: "call_1",
      name: PAIN_POINT_COLLATERAL_INTAKE_TOOL_NAME,
      arguments: { transcript: "Real transcript.", noteId: "note_123" },
    },
    new AbortController().signal,
  );
  expect(JSON.parse(String(result.content))).toEqual({
    source: "transcript",
    transcript: "Real transcript.",
  });
});

test("run reports no source when neither field is given", async () => {
  const bundle = PAIN_POINT_COLLATERAL_INTAKE_TOOL(testEnv());
  const result = await bundle.run(
    {
      id: "call_1",
      name: PAIN_POINT_COLLATERAL_INTAKE_TOOL_NAME,
      arguments: {},
    },
    new AbortController().signal,
  );
  expect(result.isError).toBe(false);
  expect(JSON.parse(String(result.content))).toEqual({ source: "none" });
});

test("run reports no source when both fields are given but blank", async () => {
  const bundle = PAIN_POINT_COLLATERAL_INTAKE_TOOL(testEnv());
  const result = await bundle.run(
    {
      id: "call_1",
      name: PAIN_POINT_COLLATERAL_INTAKE_TOOL_NAME,
      arguments: { transcript: "   ", noteId: "" },
    },
    new AbortController().signal,
  );
  expect(JSON.parse(String(result.content))).toEqual({ source: "none" });
});

test("run rejects malformed arguments (wrong types) without throwing, never passing raw JSON through", async () => {
  const bundle = PAIN_POINT_COLLATERAL_INTAKE_TOOL(testEnv());
  const result = await bundle.run(
    {
      id: "call_1",
      name: PAIN_POINT_COLLATERAL_INTAKE_TOOL_NAME,
      arguments: { transcript: 12345 },
    },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("Invalid trigger input");
});

test("run rejects unknown fields rather than passing raw unknown JSON through", async () => {
  const bundle = PAIN_POINT_COLLATERAL_INTAKE_TOOL(testEnv());
  const result = await bundle.run(
    {
      id: "call_1",
      name: PAIN_POINT_COLLATERAL_INTAKE_TOOL_NAME,
      arguments: { transcript: "hi", extra: "not allowed" },
    },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("Invalid trigger input");
});
