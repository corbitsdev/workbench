// A finding's stable identity: a content-hash fingerprint over the file,
// line, and normalized summary that identifies it. Two reviewers who
// raise the same problem in different words still land on the same
// fingerprint if their summary normalizes the same way, which is what
// lets aggregation credit both under one entry; a fingerprint embedded
// in the posted comment is also the marker a re-run reads back to know
// this finding was already posted, so it is never raised twice.
import { createHash } from "node:crypto";

import type { ReviewerFinding } from "./report";

/** The HTML comment marker a fingerprint is embedded under in posted text. */
const MARKER_PREFIX = "<!-- code-review:finding:";
const MARKER_SUFFIX = " -->";
const MARKER_PATTERN = /<!-- code-review:finding:([0-9a-f]{64}) -->/g;

function normalizedSummary(summary: string): string {
  return summary.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The stable id for one finding: SHA-256 over its file, line, and
 * normalized summary. Two findings that would render as the same body
 * line share a fingerprint, by design — that is the same identity
 * aggregation already dedupes on.
 */
export function fingerprintOf(finding: ReviewerFinding): string {
  const line = finding.line === undefined ? "" : String(finding.line);
  const key = `${finding.file}\n${line}\n${normalizedSummary(finding.summary)}`;
  return createHash("sha256").update(key).digest("hex");
}

/** Embeds a fingerprint as an invisible marker in posted markdown. */
export function fingerprintMarker(fingerprint: string): string {
  return `${MARKER_PREFIX}${fingerprint}${MARKER_SUFFIX}`;
}

/** Reads every fingerprint marker out of previously posted comment bodies. */
export function fingerprintsIn(bodies: readonly string[]): ReadonlySet<string> {
  const found = new Set<string>();
  for (const body of bodies) {
    for (const match of body.matchAll(MARKER_PATTERN)) {
      const fingerprint = match[1];
      if (fingerprint !== undefined) found.add(fingerprint);
    }
  }
  return found;
}
