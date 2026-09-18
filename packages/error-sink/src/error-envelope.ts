// The one shape every hub route uses to answer a user-visible failure. The
// raw failure never crosses the wire — it stays in the hub's own logger,
// keyed by the same `refId`.

import { type } from "arktype";
import { generateRefId } from "./ref-id";

export const ErrorEnvelopeShape = type({
  error: {
    code: "string",
    userMessage: "string",
    refId: "string",
  },
});

export type ErrorEnvelope = typeof ErrorEnvelopeShape.infer;

export function makeErrorEnvelope(args: {
  code: string;
  userMessage: string;
  refId?: string;
}): ErrorEnvelope {
  return {
    error: {
      code: args.code,
      userMessage: args.userMessage,
      refId: args.refId ?? generateRefId(),
    },
  };
}

/** Parses a hub error response body against `ErrorEnvelopeShape`. Returns
 * `undefined` for anything that doesn't match — malformed or legacy
 * bodies never crash a client that expected the envelope. */
export function parseErrorEnvelope(body: unknown): ErrorEnvelope | undefined {
  const parsed = ErrorEnvelopeShape(body);
  return parsed instanceof type.errors ? undefined : parsed;
}
