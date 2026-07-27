import { type } from "arktype";

// Durable pending gate-signal record. Serialized into the run record's
// `pending_signal` jsonb column at the accept boundary and validated back out
// wherever it crosses that boundary. Lives in its own module (not
// run-store.ts) so readers that mock the store boundary in tests — the
// reconciler's — still parse through the SAME schema the store uses.
export const PendingRunSignalSchema = type({
  signalId: "string",
  signalName: "string",
  payload: "unknown",
  receivedAt: "string",
  // Count of reconciler redeliveries so far; absent (legacy record) counts as
  // 0. Read by the reconciler's dead-letter cap so a signal that can never
  // fold (e.g. the run's event log was lost) stops being redelivered forever.
  "redeliveries?": "number",
  // Whether the WRITER already called `sendSignalDeliver` synchronously in
  // the same request. `true` (acceptGateSignal / resumeWorkflowRun in
  // run-exec.ts): this row is not the reconciler's first delivery, it is a
  // durable receipt backstop for a dispatch that already happened, so the
  // reconciler's redelivery backoff must apply even on its first pass
  // (attempts still 0) — otherwise a tick landing before the log folds
  // `SignalReceived` sends a premature duplicate. `false` (explicitly written
  // by deliverStartIntakeSignal / queueScheduledIntakeSignal —
  // CL-3509/CL-4548): the row is QUEUED-ONLY, nothing has been sent yet, and
  // the reconciler's next pass IS the genuine first delivery — the backoff
  // must be skipped or an intake-gated run sits idle for up to a full window
  // for no reason.
  //
  // ABSENT DEFAULTS TO "DISPATCHED" (true), NOT "queued" — the inverse of
  // what the key name alone would suggest. This is deliberate: the
  // queued-only path is new (CL-4548); every row that could already exist in
  // staging/production before it shipped was written by the always-dispatched
  // acceptGateSignal/resumeWorkflowRun paths and will never carry this key.
  // Defaulting absent to "queued" would misclassify every one of those
  // legacy rows and skip their backoff on deploy — a transient but real
  // duplicate-delivery risk with no migration to close it. Defaulting absent
  // to "dispatched" instead means a legacy row gets exactly its pre-existing
  // behavior (backoff enforced), byte-for-byte, with no migration needed.
  "dispatched?": "boolean",
});
export type PendingRunSignal = typeof PendingRunSignalSchema.infer;
