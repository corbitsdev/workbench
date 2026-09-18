// The structured shape every `reportError` call carries. Free-form detail
// beyond these named fields belongs in `extra`, never inlined into a
// string message.
import { type } from "arktype";

export const ErrorContext = type({
  operation: "string > 0",
  "tenantId?": "string > 0",
  "roomId?": "string > 0",
  "agentId?": "string > 0",
  "refId?": "string > 0",
  "extra?": "Record<string, unknown>",
});

export type ErrorContext = typeof ErrorContext.infer;
