import { expect, test } from "bun:test";
import type { BaseEnv } from "@intx/agent";
import type { ToolCall } from "@intx/types/runtime";

import {
  ARTIFACT_LIST_RECENT_TOOL,
  ARTIFACT_LIST_RECENT_UNAVAILABLE_REASON,
  artifactTools,
} from "./tool";

const CALL: ToolCall = {
  id: "call_1",
  name: ARTIFACT_LIST_RECENT_TOOL,
  arguments: {},
};

// The factory ignores its env entirely (no credential to resolve, only a
// platform gap to report honestly), so an empty object stands in for a
// full BaseEnv fixture here.
function emptyEnv(): BaseEnv {
  return {} as unknown as BaseEnv;
}

test("declares the artifact_list_recent tool", () => {
  const bundle = artifactTools(emptyEnv());
  expect(bundle.definitions.map((d) => d.name)).toEqual([
    ARTIFACT_LIST_RECENT_TOOL,
  ]);
});

test("needs no env requirements: the gap is structural, not a missing credential", () => {
  expect(artifactTools.requires).toEqual([]);
});

test("always returns an honest, non-throwing 'not reachable yet' error, citing the platform gap", async () => {
  const bundle = artifactTools(emptyEnv());
  const result = await bundle.run(CALL, new AbortController().signal);
  expect(result.isError).toBe(true);
  expect(result.content).toBe(ARTIFACT_LIST_RECENT_UNAVAILABLE_REASON);
  expect(result.content).toMatch(/not reachable/i);
  expect(result.content).toMatch(/CL-6000/);
});

test("never fabricates artifact content regardless of the requested limit", async () => {
  const bundle = artifactTools(emptyEnv());
  const result = await bundle.run(
    { id: "call_2", name: ARTIFACT_LIST_RECENT_TOOL, arguments: { limit: 50 } },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
});
