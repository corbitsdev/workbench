/**
 * Compatibility surface for the versioned prompt builders. The canonical v1
 * builder lives in `prompts/v1.ts` (moved verbatim — every existing import of
 * `./prompt` keeps resolving to the byte-identical v1 prompt); v2 lives in
 * `prompts/v2.ts` and is selected per variant, never as a silent default.
 */
export * from "./prompts/v1";
