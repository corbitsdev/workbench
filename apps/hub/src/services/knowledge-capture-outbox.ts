import { type } from "arktype";
import { getLogger } from "@intx/log";
import type { WorkUnitQueue } from "./work-unit-queue";

const log = getLogger(["services", "knowledge-capture-outbox"]);

export const KNOWLEDGE_CAPTURE_KIND = "knowledge_capture" as const;

export const KnowledgeCapturePayloadSchema = type({
  artifactId: "string",
  "version?": "number",
  "contentHash?": "string",
  "sourceRef?": "string",
});
export type KnowledgeCapturePayload =
  typeof KnowledgeCapturePayloadSchema.infer;

/** Env flag: when true, product writes enqueue a work unit instead of
 * (or in addition to) running capture inline. Default false until proven. */
export function knowledgeCaptureOutboxEnabled(): boolean {
  const raw = process.env["KNOWLEDGE_CAPTURE_OUTBOX"];
  if (raw === undefined || raw.trim() === "") return false;
  return raw === "1" || raw.toLowerCase() === "true";
}

export function knowledgeCaptureIdempotencyKey(args: {
  artifactId: string;
  version?: number;
  contentHash?: string;
  sourceRef?: string;
}): string {
  if (args.sourceRef) return `source:${args.sourceRef}`;
  if (args.contentHash) {
    return `artifact:${args.artifactId}:hash:${args.contentHash}`;
  }
  const version = args.version ?? 0;
  return `artifact:${args.artifactId}:v${version}`;
}

/**
 * After a product write commits, enqueue knowledge capture. Never throws for
 * queue failures — capture must not roll back or block the product write.
 */
export async function enqueueKnowledgeCaptureAfterWrite(
  queue: WorkUnitQueue,
  args: {
    tenantId: string;
    artifactId: string;
    version?: number;
    contentHash?: string;
    sourceRef?: string;
  },
): Promise<{ enqueued: boolean; id?: string }> {
  if (!knowledgeCaptureOutboxEnabled()) {
    return { enqueued: false };
  }

  const payload: KnowledgeCapturePayload = {
    artifactId: args.artifactId,
    ...(args.version !== undefined ? { version: args.version } : {}),
    ...(args.contentHash !== undefined
      ? { contentHash: args.contentHash }
      : {}),
    ...(args.sourceRef !== undefined ? { sourceRef: args.sourceRef } : {}),
  };

  try {
    const result = await queue.enqueue({
      tenantId: args.tenantId,
      kind: KNOWLEDGE_CAPTURE_KIND,
      idempotencyKey: knowledgeCaptureIdempotencyKey(args),
      payload,
    });
    return { enqueued: result.created || true, id: result.id };
  } catch (err) {
    log.error(
      "knowledge capture outbox: enqueue failed after product write {artifactId}",
      {
        artifactId: args.artifactId,
        tenantId: args.tenantId,
        error: err instanceof Error ? err : new Error(String(err)),
      },
    );
    return { enqueued: false };
  }
}

export type KnowledgeCaptureRunner = (args: {
  tenantId: string;
  payload: KnowledgeCapturePayload;
  signal: AbortSignal;
}) => Promise<void>;

/**
 * Process one claimed knowledge_capture unit. Failures are rethrown so the
 * work-unit worker can fail/backoff the lease.
 */
export async function runKnowledgeCaptureUnit(args: {
  tenantId: string;
  payload: unknown;
  runner: KnowledgeCaptureRunner;
  signal: AbortSignal;
}): Promise<void> {
  const parsed = KnowledgeCapturePayloadSchema(args.payload);
  if (parsed instanceof type.errors) {
    throw new Error(`invalid knowledge_capture payload: ${parsed.summary}`);
  }
  await args.runner({
    tenantId: args.tenantId,
    payload: parsed,
    signal: args.signal,
  });
}
