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
});
export type PendingRunSignal = typeof PendingRunSignalSchema.infer;
