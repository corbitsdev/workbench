// Which deployed workflow asset names pin a given connector's tool package,
// per CL-5999's toolPackagePins mechanism (see workflows/granola-call/src/index.ts
// and siblings, each exporting a *_TOOL_PACKAGE_PINS const). This is a hand-maintained
// approximation, not a live query against deployed definitions — see the design
// doc's honesty note: "Pinned by" (not "Used by") is the correct label for exactly
// this reason, until CL-6028's item 9 (tool-package credential-binding adoption)
// makes it exact.
export const CONNECTOR_PINNED_WORKFLOWS: Readonly<
  Record<string, readonly string[]>
> = {
  granola: [
    "granola-call",
    "process-granola-call",
    "morning-brief",
    "pain-point-collateral",
    "collateral-generation",
  ],
  linear: ["morning-brief", "collateral-generation"],
  exa: ["last-30-days-research"],
  scrapecreators: ["reddit-opportunity-scanner"],
  github: [],
};
