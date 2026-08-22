import { describe, expect, test } from "bun:test";

import {
  WORKFLOW_RUN_RUNS_PREFIX,
  readCommittedWorkflowRunTerminalStatus,
  workflowRunKindHandler,
} from "./workflow-run-kind";
import { WORKFLOW_RUN_EVENTS_FILE } from "./workflow-run-event-log";
import type { CommittedReads, CommittedTreeEntry } from "./repo-store";

const encoder = new TextEncoder();

/** A `CommittedReads` fake backed by an in-memory path -> content map. */
function makeCommittedReads(files: Record<string, string>): CommittedReads {
  const oidFor = (path: string) => `oid:${path}`;
  return {
    listDir: async (relPath: string): Promise<CommittedTreeEntry[]> => {
      const prefix = relPath === "" ? "" : `${relPath}/`;
      const children = new Map<string, CommittedTreeEntry>();
      for (const p of Object.keys(files)) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const [name, ...more] = rest.split("/");
        if (name === undefined) continue;
        children.set(name, {
          name,
          oid: more.length === 0 ? oidFor(p) : oidFor(`${prefix}${name}`),
          type: more.length === 0 ? "blob" : "tree",
        });
      }
      return [...children.values()];
    },
    readBlobByOid: async (oid: string): Promise<Uint8Array> => {
      for (const [p, content] of Object.entries(files)) {
        if (oidFor(p) === oid) return encoder.encode(content);
      }
      throw new Error(`no such blob oid: ${oid}`);
    },
    treeOid: async () => null,
  };
}

/**
 * A minimal in-memory tree: paths are POSIX, root-relative, no leading
 * slash. `listDir` returns the direct child names of a directory path
 * (files and subdirectories alike, matching the substrate's contract);
 * `readBlob`/`priorReadBlob` resolve a file's own bytes.
 */
function makeTree(files: Record<string, string>) {
  const paths = Object.keys(files);
  const listDir = async (dir: string): Promise<string[]> => {
    const prefix = dir === "" ? "" : `${dir}/`;
    const children = new Set<string>();
    for (const p of paths) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const name = rest.split("/")[0];
      if (name !== undefined) children.add(name);
    }
    return [...children];
  };
  const readBlob = async (path: string): Promise<Uint8Array> => {
    const content = files[path];
    if (content === undefined) throw new Error(`no such blob: ${path}`);
    return encoder.encode(content);
  };
  return { listDir, readBlob };
}

function emptyPrior() {
  return {
    priorListDir: async () => [],
    priorReadBlob: async () => null,
  };
}

const hubPrincipal = { kind: "hub" as const };

describe("workflowRunKindHandler.validatePush — CL-6595 combined-run terminal detection", () => {
  test("a run sealed from birth (events.jsonl only, never per-event files) is reported newly terminal", async () => {
    // This is the exact shape of the runs behind CL-6595: the run's own
    // trace page already says "This run finished before we started
    // recording steps" because its entire event log arrived pre-combined
    // in a single push, with no per-event `<seq>.json` blobs ever landing.
    const combined = [
      JSON.stringify({ type: "RunStarted", seq: 0 }),
      JSON.stringify({ type: "RunCompleted", seq: 1 }),
    ].join("\n");
    const { listDir, readBlob } = makeTree({
      [`${WORKFLOW_RUN_RUNS_PREFIX}/run_1/${WORKFLOW_RUN_EVENTS_FILE}`]: combined,
    });

    const result = await workflowRunKindHandler.validatePush({
      repoId: { kind: "workflow-run", id: "run_1" },
      ref: "refs/heads/main",
      principal: hubPrincipal,
      topLevelTreePaths: [WORKFLOW_RUN_RUNS_PREFIX],
      readBlob,
      listDir,
      ...emptyPrior(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.newlyTerminalRuns).toEqual([
      { runId: "run_1", status: "completed", terminalEventJson: expect.any(String) },
    ]);
  });

  test("a run already sealed in the prior tree is not reported newly terminal again", async () => {
    const combined = [
      JSON.stringify({ type: "RunStarted", seq: 0 }),
      JSON.stringify({ type: "RunFailed", seq: 1 }),
    ].join("\n");
    const files = {
      [`${WORKFLOW_RUN_RUNS_PREFIX}/run_1/${WORKFLOW_RUN_EVENTS_FILE}`]: combined,
    };
    const { listDir, readBlob } = makeTree(files);
    const prior = makeTree(files);

    const result = await workflowRunKindHandler.validatePush({
      repoId: { kind: "workflow-run", id: "run_1" },
      ref: "refs/heads/main",
      principal: hubPrincipal,
      topLevelTreePaths: [WORKFLOW_RUN_RUNS_PREFIX],
      readBlob,
      listDir,
      priorListDir: prior.listDir,
      priorReadBlob: async (path) => {
        try {
          return await prior.readBlob(path);
        } catch {
          return null;
        }
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.newlyTerminalRuns ?? []).toEqual([]);
  });

  test("a live per-event run with no terminal event yet is not reported terminal", async () => {
    const { listDir, readBlob } = makeTree({
      [`${WORKFLOW_RUN_RUNS_PREFIX}/run_1/events/0.json`]: JSON.stringify({
        type: "RunStarted",
        seq: 0,
      }),
    });

    const result = await workflowRunKindHandler.validatePush({
      repoId: { kind: "workflow-run", id: "run_1" },
      ref: "refs/heads/main",
      principal: hubPrincipal,
      topLevelTreePaths: [WORKFLOW_RUN_RUNS_PREFIX],
      readBlob,
      listDir,
      ...emptyPrior(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.newlyTerminalRuns ?? []).toEqual([]);
  });
});

describe("readCommittedWorkflowRunTerminalStatus", () => {
  test("maps a sealed run's terminal event to its workflow_run.status", async () => {
    const reads = makeCommittedReads({
      [`${WORKFLOW_RUN_RUNS_PREFIX}/run_1/${WORKFLOW_RUN_EVENTS_FILE}`]: [
        JSON.stringify({ type: "RunStarted", seq: 0 }),
        JSON.stringify({ type: "RunCancelled", seq: 1 }),
      ].join("\n"),
    });
    expect(
      await readCommittedWorkflowRunTerminalStatus(reads, "run_1"),
    ).toBe("cancelled");
  });

  test("returns null for a live per-event run", async () => {
    const reads = makeCommittedReads({
      [`${WORKFLOW_RUN_RUNS_PREFIX}/run_1/events/0.json`]: JSON.stringify({
        type: "RunStarted",
        seq: 0,
      }),
    });
    expect(
      await readCommittedWorkflowRunTerminalStatus(reads, "run_1"),
    ).toBeNull();
  });

  test("returns null for an absent run", async () => {
    const reads = makeCommittedReads({});
    expect(
      await readCommittedWorkflowRunTerminalStatus(reads, "run_1"),
    ).toBeNull();
  });

  test("returns null when reads is null (no ref/repo yet)", async () => {
    expect(
      await readCommittedWorkflowRunTerminalStatus(null, "run_1"),
    ).toBeNull();
  });
});
