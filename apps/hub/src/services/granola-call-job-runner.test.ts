import { describe, expect, mock, test } from "bun:test";

// createGranolaTools and the tenant-credential resolver are mocked at their
// module boundaries: the runner's own wiring (claim → fetch full note → hand
// off to pipeline → complete/fail) is the unit under test.
const fullNotes: Record<string, unknown> = {
  "note-1": {
    id: "note-1",
    title: "Discovery",
    participants: ["a@corbits.io"],
    transcript: [{ text: "hello" }, { text: "world" }],
  },
};
let getNoteShouldThrow = false;
mock.module("@workbench/tools-granola", () => ({
  createGranolaTools: () => [
    {
      kind: "string",
      definition: { name: "granola_get_note" },
      handler: async (args: Record<string, unknown>) => {
        if (getNoteShouldThrow) throw new Error("granola API 503");
        return JSON.stringify(fullNotes[args.noteId as string]);
      },
    },
  ],
}));
mock.module("../lib/member-tool-credential", () => ({
  resolveTenantToolCredential: async () => ({
    apiKey: "k",
    baseURL: "",
    source: "tenant",
  }),
}));

const { createGranolaCallJobRunner } = await import(
  "./granola-call-job-runner"
);
import type { GranolaCallJobQueue } from "./granola-call-job-queue";
import type {
  GranolaCallPipeline,
  ProcessCallInput,
  ProcessCallResult,
} from "./granola-call-pipeline";
import type { GranolaCallJobRow } from "../db/schema";

function makeJob(
  overrides: Partial<GranolaCallJobRow> = {},
): GranolaCallJobRow {
  return {
    id: "job-1",
    tenantId: "ten-1",
    noteId: "note-1",
    status: "processing",
    attempts: 0,
    nextAttemptAt: new Date(),
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function fakeQueue(jobs: GranolaCallJobRow[]): {
  queue: GranolaCallJobQueue;
  completed: string[];
  failed: { jobId: string; attempts: number; error: string }[];
} {
  const completed: string[] = [];
  const failed: { jobId: string; attempts: number; error: string }[] = [];
  const queue: GranolaCallJobQueue = {
    enqueue: async () => {},
    claimDue: async () => jobs,
    complete: async (jobId) => {
      completed.push(jobId);
    },
    fail: async (jobId, attempts, error) => {
      failed.push({ jobId, attempts, error });
    },
  };
  return { queue, completed, failed };
}

function fakePipeline(
  impl?: (input: ProcessCallInput) => Promise<ProcessCallResult>,
): { pipeline: GranolaCallPipeline; calls: ProcessCallInput[] } {
  const calls: ProcessCallInput[] = [];
  const pipeline: GranolaCallPipeline = {
    processCall: async (input) => {
      calls.push(input);
      if (impl) return impl(input);
      return { status: "processed", artifactId: "art-1", delivered: 1 };
    },
  };
  return { pipeline, calls };
}

describe("granola call job runner", () => {
  test("runOnce claims a due job, fetches the full note, hands it to the pipeline, and completes it", async () => {
    getNoteShouldThrow = false;
    const job = makeJob();
    const { queue, completed } = fakeQueue([job]);
    const { pipeline, calls } = fakePipeline();
    const runner = createGranolaCallJobRunner({
      db: {} as never,
      queue,
      pipeline,
    });

    await runner.runOnce();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.tenantId).toBe("ten-1");
    expect(calls[0]?.note.id).toBe("note-1");
    expect(calls[0]?.note.transcript).toBe("hello\nworld");
    expect(completed).toEqual(["job-1"]);
  });

  test("a transcript-fetch failure fails the job with the incremented attempt count (retry path)", async () => {
    getNoteShouldThrow = true;
    const job = makeJob({ attempts: 2 });
    const { queue, failed } = fakeQueue([job]);
    const { pipeline, calls } = fakePipeline();
    const runner = createGranolaCallJobRunner({
      db: {} as never,
      queue,
      pipeline,
    });

    await runner.runOnce();

    expect(calls).toHaveLength(0);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.jobId).toBe("job-1");
    expect(failed[0]?.attempts).toBe(3);
    expect(failed[0]?.error).toContain("granola API 503");
  });

  test("a pipeline failure (e.g. transient LLM error) fails the job rather than throwing out of runOnce", async () => {
    getNoteShouldThrow = false;
    const job = makeJob({ attempts: 0 });
    const { queue, failed, completed } = fakeQueue([job]);
    const { pipeline } = fakePipeline(async () => {
      throw new Error("transient LLM error");
    });
    const runner = createGranolaCallJobRunner({
      db: {} as never,
      queue,
      pipeline,
    });

    await runner.runOnce();

    expect(completed).toEqual([]);
    expect(failed).toEqual([
      { jobId: "job-1", attempts: 1, error: "transient LLM error" },
    ]);
  });

  test("re-processing a job whose note the pipeline already persisted (skipped-duplicate) still completes the job (idempotent re-run)", async () => {
    getNoteShouldThrow = false;
    const job = makeJob();
    const { queue, completed } = fakeQueue([job]);
    const { pipeline, calls } = fakePipeline(async () => ({
      status: "skipped-duplicate",
    }));
    const runner = createGranolaCallJobRunner({
      db: {} as never,
      queue,
      pipeline,
    });

    await runner.runOnce();

    expect(calls).toHaveLength(1);
    expect(completed).toEqual(["job-1"]);
  });

  test("runOnce with no due jobs does not touch the pipeline", async () => {
    const { queue, completed, failed } = fakeQueue([]);
    const { pipeline, calls } = fakePipeline();
    const runner = createGranolaCallJobRunner({
      db: {} as never,
      queue,
      pipeline,
    });

    await runner.runOnce();

    expect(calls).toEqual([]);
    expect(completed).toEqual([]);
    expect(failed).toEqual([]);
  });
});
