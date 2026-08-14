import { expect, test } from "bun:test";
import type { RepoId, RepoStore } from "@intx/hub-sessions";

import { writeStepGrants } from "./step-strategy";

type CapturedWrite = {
  repoId: RepoId;
  ref: string;
  files: Record<string, string | Uint8Array>;
};

function makeCapturingRepoStore(): {
  store: RepoStore;
  writes: CapturedWrite[];
} {
  const writes: CapturedWrite[] = [];
  const store = {
    writeTree: (
      _principal: unknown,
      repoId: RepoId,
      ref: string,
      args: { files: Record<string, string | Uint8Array> },
    ) => {
      writes.push({ repoId, ref, files: args.files });
      return Promise.resolve("sha");
    },
  } as unknown as RepoStore;
  return { store, writes };
}

test("per-run mode writes runs/<runId>/grants.json into the workflow-run repo", async () => {
  const { store, writes } = makeCapturingRepoStore();
  await writeStepGrants({
    repoStore: store,
    deploymentId: "dep-1",
    stepOrder: ["step-1", "step-2"],
    deriveStepRepoId: ({ runId, stepId }) => ({
      kind: "agent-state",
      id: `${runId}-${stepId}`,
    }),
    grants: [{ resource: "tool:echo", action: "invoke" }],
    runId: "run-1",
  });
  expect(writes).toHaveLength(1);
  const write = writes[0];
  expect(write?.repoId).toEqual({ kind: "workflow-run", id: "dep-1" });
  expect(Object.keys(write?.files ?? {})).toEqual(["runs/run-1/grants.json"]);
  expect(JSON.parse(String(write?.files["runs/run-1/grants.json"]))).toEqual({
    grants: [{ resource: "tool:echo", action: "invoke" }],
  });
});

test("step fan-out mode writes one agent-state grants file per step", async () => {
  const { store, writes } = makeCapturingRepoStore();
  await writeStepGrants({
    repoStore: store,
    deploymentId: "dep-1",
    stepOrder: ["step-1", "step-2"],
    deriveStepRepoId: ({ runId, stepId }) => ({
      kind: "agent-state",
      id: `${runId}-${stepId}`,
    }),
    grants: undefined,
  });
  expect(writes.map((w) => w.repoId)).toEqual([
    { kind: "agent-state", id: "dep-1-step-1" },
    { kind: "agent-state", id: "dep-1-step-2" },
  ]);
  for (const write of writes) {
    expect(JSON.parse(String(write.files["state/grants.json"]))).toEqual({
      grants: [],
    });
  }
});
