// The capability vocabulary is the platform's, verbatim. `@intx/types`'
// `WIRE_CAPABILITIES` is the canonical list and its arktype `Capability` is
// built from it, so re-exporting both here gives this package one import
// point without declaring a second vocabulary that could drift from the one
// source resolution filters against.
export { Capability, WIRE_CAPABILITIES } from "@intx/types";
