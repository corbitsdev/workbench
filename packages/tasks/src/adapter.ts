import { type } from "arktype";
import type { Task, TaskExternalRef } from "@workbench/shared";

// A self-describing downstream task adapter (CL-3302). The registry mirrors the
// hub tool-registry house pattern: a static, hand-merged, name-keyed map of
// descriptors — not a dynamic plugin system. Adding a system is registration
// (one descriptor + one credential-catalog line), not a core change.

export const taskAdapterOperations = [
  "create",
  "update",
  "close",
  "comment",
  "sync_back",
] as const;
export const TaskAdapterOperationSchema = type.enumerated(
  ...taskAdapterOperations,
);
export type TaskAdapterOperation = typeof TaskAdapterOperationSchema.infer;

// Everything except `sync_back` is a native -> external push. `sync_back` is
// declared now (v2, poll-based) so the descriptor shape does not change later.
export type TaskAdapterExecutableOperation = Exclude<
  TaskAdapterOperation,
  "sync_back"
>;

// The serializable, self-described half of an adapter. Exported as the source
// of truth so the hub and UI can enumerate adapters without knowing their names.
export const TaskAdapterDescriptorSchema = type({
  id: "string",
  label: "string",
  providerName: "string",
  operations: TaskAdapterOperationSchema.array(),
  externalRef: {
    idLabel: "string",
    "urlTemplate?": "string",
  },
});
export type TaskAdapterDescriptor = typeof TaskAdapterDescriptorSchema.infer;

// What an adapter push receives. Everything is derived from the durable task
// snapshot + the existing ref, so a create is fully reproducible by the
// reconciler (no ephemeral per-call params).
export type TaskPushInput = {
  task: Task;
  externalRef: TaskExternalRef | null;
  idempotencyKey: string;
  actorPrincipalId: string;
  assignee: string | null;
};

export type TaskPushResult = {
  externalId: string;
  externalUrl?: string;
  deduped: boolean;
};

// The executable half. `execute` cannot be expressed in arktype (it is a
// function), so the adapter is the descriptor intersected with it — the same
// convention as the fetcher-intersection rule in AGENTS.md.
export type TaskAdapter = TaskAdapterDescriptor & {
  execute: (
    op: TaskAdapterExecutableOperation,
    input: TaskPushInput,
    config: { apiKey: string; baseURL: string },
  ) => Promise<TaskPushResult>;
};
