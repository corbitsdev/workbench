import type { WorkUnitQueue } from "./work-unit-queue";
import { enqueueKnowledgeCaptureAfterWrite } from "./knowledge-capture-outbox";

/**
 * Process-wide binder so product-write paths (e.g. write_artifact) can enqueue
 * knowledge-capture work units without taking a WorkUnitQueue constructor arg
 * through every tool context. Wired once at hub boot.
 */
let boundQueue: WorkUnitQueue | null = null;

export function bindKnowledgeCaptureWorkUnitQueue(
  queue: WorkUnitQueue | null,
): void {
  boundQueue = queue;
}

export async function maybeEnqueueKnowledgeCaptureAfterArtifactWrite(args: {
  tenantId: string;
  artifactId: string;
  version: number;
  contentHash?: string;
  sourceRef?: string;
}): Promise<{ enqueued: boolean; id?: string }> {
  if (!boundQueue) return { enqueued: false };
  return enqueueKnowledgeCaptureAfterWrite(boundQueue, args);
}
