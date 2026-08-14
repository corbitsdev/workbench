// Deploy-layer metadata for seeded workflow packages. Interchange's
// defineWorkflow has no automatable / display-name fields; each
// workflows/*/package.json carries a `corbits.workflow` block, and this
// module is the TypeScript mirror both seed and the web picker import.
// Keep the two in lockstep — the package.json block is the npm-visible
// source of truth for package authors; this list is what runtime code
// reads.

export type WorkflowCatalogEntry = {
  readonly assetName: string;
  readonly displayName: string;
  /** Schedulable as a Routine. False for conversational agents / chat hosts. */
  readonly automatable: boolean;
  /** One honest sentence: what this workflow actually does. No metrics, no hype. */
  readonly whatItDoes: string;
  /**
   * Connector ids (see `@workbench/connections/registry`'s
   * `CONNECTOR_REGISTRY`) this workflow's tool packages call. Empty for
   * workflows with no external connector dependency.
   */
  readonly requiredConnections: readonly string[];
  /** A 2-3 line honest sample of what a run actually produces. */
  readonly exampleOutput: string;
  /** A short, honestly-hedged hint — never fabricated precision. */
  readonly typicalDuration: string;
};

/**
 * Every known workbench workflow package, keyed by the asset name seed
 * deploys under. Agent definitions created at runtime are never listed
 * here, so they cannot pass the automatable filter by accident.
 */
export const WORKFLOW_CATALOG: readonly WorkflowCatalogEntry[] = [
  {
    assetName: "echo",
    displayName: "Echo",
    automatable: false,
    whatItDoes:
      "Replies with the exact text it received — a wiring check for the mail-triggered contract, not a real assistant.",
    requiredConnections: [],
    exampleOutput: "You: Testing 1 2 3\nEcho: Testing 1 2 3",
    typicalDuration: "a few seconds",
  },
  {
    assetName: "assistant",
    displayName: "Myra",
    automatable: false,
    whatItDoes:
      "A general-purpose assistant for the workspace — answers questions, drafts text, and reasons through problems in conversation.",
    requiredConnections: [],
    exampleOutput:
      "You: Draft a short reply declining this meeting.\nMyra: Here's a short, polite decline you can send as-is...",
    typicalDuration: "varies with the conversation",
  },
  {
    assetName: "heartbeat",
    displayName: "Heartbeat",
    automatable: true,
    whatItDoes:
      "Completes immediately on every trigger with no real reply — a lightweight target for testing scheduling and mail triggers.",
    requiredConnections: [],
    exampleOutput: "Run completed at the trigger time. No reply content.",
    typicalDuration: "a few seconds",
  },
  {
    assetName: "channel-digest",
    displayName: "Channel digest",
    automatable: true,
    whatItDoes:
      "Relays a scheduler-computed digest line straight into a channel, unchanged — the digest content itself comes entirely from its trigger.",
    requiredConnections: [],
    exampleOutput: "12 messages since yesterday · last post 9:41am",
    typicalDuration: "a few seconds",
  },
  {
    assetName: "granola-call",
    displayName: "Granola call notes",
    automatable: true,
    whatItDoes:
      "Polls Granola for recent calls and starts one process-granola-call run per call that doesn't yet have published notes.",
    requiredConnections: ["granola"],
    exampleOutput:
      "Checked the last 10 calls. Started process-granola-call runs for 2 new calls; the rest already had published notes.",
    typicalDuration: "a few seconds",
  },
  {
    assetName: "process-granola-call",
    displayName: "Process Granola call",
    automatable: false,
    whatItDoes:
      "Fetches one call's transcript and publishes five-section working notes — Participants, Summary, Pain points, Decisions, Action items — grounded in the transcript.",
    requiredConnections: ["granola"],
    exampleOutput:
      "Participants: Jamie (Acme), Priya (sales)\nSummary: Renewal discussion, pricing questions raised.\nAction items: Send updated quote by Friday.",
    typicalDuration: "1-2 minutes",
  },
  {
    assetName: "morning-brief",
    displayName: "Morning brief",
    automatable: true,
    whatItDoes:
      "Pulls the sender's recent Granola calls and Linear issues and writes a three-section daily brief: what happened, what needs attention, and suggested next actions.",
    requiredConnections: ["granola", "linear"],
    exampleOutput:
      "## What happened\n2 calls logged, 3 issues updated.\n## What needs attention today\nCLI-142 is blocked on review.",
    typicalDuration: "under a minute",
  },
  {
    assetName: "pain-point-collateral",
    displayName: "Pain-point collateral",
    automatable: false,
    whatItDoes:
      "Extracts a customer's real pain points from a call transcript and drafts one piece of targeted collateral, held for approval before it's finalized.",
    requiredConnections: ["granola"],
    exampleOutput:
      'Draft: "Slow onboarding is costing you deals" — a one-pager targeting the onboarding-speed pain point raised on the call.',
    typicalDuration: "a few minutes, plus the time to approve",
  },
  {
    assetName: "collateral-generation",
    displayName: "Collateral generation",
    automatable: false,
    whatItDoes:
      "Drafts marketing collateral across picked content types from Granola notes, Linear issues, or pasted text, with a swipe review on every draft and one approval on the final set.",
    requiredConnections: ["granola", "linear"],
    exampleOutput:
      "3 drafts ready for review: a LinkedIn post, a short blog, and a Twitter thread — swipe Good/Bad/Regenerate on each.",
    typicalDuration: "several minutes, plus review and approval time",
  },
  {
    assetName: "reddit-opportunity-scanner",
    displayName: "Reddit opportunity scanner",
    automatable: false,
    whatItDoes:
      "Scores Reddit posts as outreach opportunities for a target website, after a review of the search plan and one approval on the final list.",
    requiredConnections: ["scrapecreators"],
    exampleOutput:
      "Ranked 6 opportunities, 2 scored 5/5 — explicit buying signals in r/smallbusiness and r/SaaS.",
    typicalDuration: "a few minutes, plus review and approval time",
  },
  {
    assetName: "last-30-days-research",
    displayName: "Last 30 days research report",
    automatable: false,
    whatItDoes:
      "Researches a topic over the last 30 days across web search and GitHub, and writes a cited report with sourced findings.",
    requiredConnections: ["exa"],
    exampleOutput:
      "## Overview\nActivity picked up mid-month.\n## Key findings\nThree new competing launches, each cited to its source.",
    typicalDuration: "1-2 minutes",
  },
];

const byAssetName = new Map(
  WORKFLOW_CATALOG.map((entry) => [entry.assetName, entry]),
);

export function isAutomatableWorkflowName(name: string): boolean {
  return byAssetName.get(name)?.automatable === true;
}

/** The full catalog entry for an asset name, or `undefined` if it isn't
 * a known workflow — the demo-card fields (`whatItDoes`, `exampleOutput`,
 * etc.) live here alongside the display name. */
export function workflowCatalogEntry(
  name: string,
): WorkflowCatalogEntry | undefined {
  return byAssetName.get(name);
}

/**
 * Friendly label for a workflow definition. Prefer the catalog display
 * name, then a non-empty description, then a humanized asset name — never
 * a raw definition id.
 */
export function workflowDisplayName(
  name: string,
  description?: string | null,
): string {
  const entry = byAssetName.get(name);
  if (entry !== undefined) return entry.displayName;
  if (description !== undefined && description !== null) {
    const trimmed = description.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return humanizeAssetName(name);
}

function humanizeAssetName(name: string): string {
  return name
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
