// Which deployed workflow asset names pin a given connector's tool package,
// per CL-5999's toolPackagePins mechanism. This is a hand-maintained
// approximation, not a live query against deployed definitions — the
// settings-ui card labels it "Used by workflows:" for readability, but
// carries the approximation caveat on a title/tooltip
// (connectionsPinnedByApproximationNote) rather than baking it into the
// label itself, until CL-6028's item 9 (tool-package credential-binding
// adoption) makes it exact.
//
// The shipped workflow catalog was deleted (owner ruling 2026-09-17):
// Myra creates workflows dynamically, so no connector is pinned by a
// seeded workflow asset name any more.
export const CONNECTOR_PINNED_WORKFLOWS: Readonly<Record<string, readonly string[]>> = {
  manus: ["assistant"],
};
