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
});
export type PendingRunSignal = typeof PendingRunSignalSchema.infer;
