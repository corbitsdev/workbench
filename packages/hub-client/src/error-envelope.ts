// Re-export the canonical envelope helpers from @corbits/error-sink.
// Consumers should import directly from @corbits/error-sink; this file
// exists only for backward compatibility with code that still imports
// from @workbench/hub-client root.
export {
  ErrorEnvelopeShape,
  generateRefId,
  makeErrorEnvelope,
  parseErrorEnvelope,
} from "@corbits/error-sink";
export type { ErrorEnvelope } from "@corbits/error-sink";
