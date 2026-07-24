// WORKBENCH-LOCAL (self-discovery resume quarantine): a single persisted run
// whose log the current interchange pin's state machine cannot replay (e.g. a
// pre-runtime-retirement `RunStarted seq 0`, which `applyEvent` rejects with
// `sequence must be >= 1`) must be skipped at boot, not crash the whole child
// before it emits `ready`. This drives the REAL `discoverInFlightRuns` across
// the real `resumeFromLog`/state-machine seam with a poison-pill run alongside
// a valid one.

import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorkflowEvent } from "@intx/workflow";
import type {
  RepoId,
  RepoStore as SubstrateRepoStore,
} from "@workbench/hub-sessions/substrate";
import type { RepoStore as RuntimeRepoStore } from "@intx/workflow";

import { discoverInFlightRuns } from "./self-discovery";

const GOOD_RUN = "good-run";
const BAD_RUN = "bad-run";

function runStarted(seq: number, runId: string): WorkflowEvent {
  return {
    kind: "RunStarted",
    seq,
    at: "2026-07-17T00:00:00.000Z",
    runId,
    definitionHash: "trivial:v1",
    trigger: { type: "mail", payload: {} },
  } as WorkflowEvent;
}

// A valid in-flight run replays to a non-terminal phase; the poison-pill run
// carries a `RunStarted` at seq 0, which the state machine rejects.
const EVENTS: Record<string, readonly WorkflowEvent[]> = {
  [GOOD_RUN]: [runStarted(1, GOOD_RUN)],
  [BAD_RUN]: [runStarted(0, BAD_RUN)],
};

function makeRuntimeRepoStore(): RuntimeRepoStore {
  return {
    read: async (runId: string) => EVENTS[runId] ?? [],
  } as unknown as RuntimeRepoStore;
}

function makeSubstrate(repoDir: string): SubstrateRepoStore {
  return {
    getRepoDir: (_repoId: RepoId) => repoDir,
  } as unknown as SubstrateRepoStore;
}

describe("discoverInFlightRuns quarantine", () => {
  it("skips an un-resumable run and returns the valid one instead of throwing", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "self-disc-"));
    await fs.mkdir(path.join(repoDir, "runs", GOOD_RUN), { recursive: true });
    await fs.mkdir(path.join(repoDir, "runs", BAD_RUN), { recursive: true });

    const discovered = await discoverInFlightRuns({
      substrate: makeSubstrate(repoDir),
      repoId: { kind: "workflow-run", id: "dep" } as RepoId,
      runtimeRepoStore: makeRuntimeRepoStore(),
    });

    // The poison-pill run is quarantined; the valid run is still discovered.
    expect(discovered.map((r) => r.runId)).toEqual([GOOD_RUN]);

    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it("propagates when the poison-pill run is the only one (still no throw; empty result)", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "self-disc-"));
    await fs.mkdir(path.join(repoDir, "runs", BAD_RUN), { recursive: true });

    const discovered = await discoverInFlightRuns({
      substrate: makeSubstrate(repoDir),
      repoId: { kind: "workflow-run", id: "dep" } as RepoId,
      runtimeRepoStore: makeRuntimeRepoStore(),
    });

    // A boot whose only persisted run is un-resumable still boots (empty set),
    // rather than crashing the child before `ready`.
    expect(discovered).toEqual([]);

    await fs.rm(repoDir, { recursive: true, force: true });
  });
});
