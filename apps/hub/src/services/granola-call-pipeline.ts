/**
 * CL-3647 — Granola call processing is a deployed workflow
 * (`workflows/granola-call`). The hub job runner only starts a run via the
 * run-start seam; there is no in-process pipeline / LLM / transcript path.
 *
 * This module re-exports pure domain types and helpers from @workbench/shared
 * so older import sites keep compiling. Prefer importing from
 * `@workbench/shared` for new code.
 */

export {
  CallActionSchema,
  CallAnalysisSchema,
  classifyCall,
  GranolaCallSchema,
  type CallAction,
  type CallAnalysis,
  type CallClassification,
  type GranolaCall,
} from "@workbench/shared";

/** @deprecated Legacy combined artifact kind. Prefer GRANOLA_CALL_ARTIFACT_KINDS. */
export const GRANOLA_CALL_ARTIFACT_KIND = "granola-call";
