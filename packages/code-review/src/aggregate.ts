// Three reviewer passes become one review. Aggregation is where the
// review earns being a single comment instead of three: findings the
// reviewers agree on are one entry crediting all of them, order runs
// blocking first, and a finding anchored to a line GitHub cannot accept
// a comment on still appears in the body rather than vanishing.
import type {
  PullRequestDiff,
  PullRequestReviewComment,
  PullRequestReviewDraft,
} from "@corbits/github-tools";

import { fingerprintMarker, fingerprintOf } from "./fingerprint";
import { parseReviewerReport, type ReviewerFinding } from "./report";
import type { ReviewerDefinition } from "./reviewers";

/** One reviewer's turn, as it came back. */
export type ReviewerPass =
  | {
      readonly reviewer: ReviewerDefinition;
      readonly ok: true;
      readonly reply: string;
    }
  | {
      readonly reviewer: ReviewerDefinition;
      readonly ok: false;
      readonly reason: string;
    };

interface AggregatedFinding {
  readonly finding: ReviewerFinding;
  readonly fingerprint: string;
  readonly reviewers: readonly string[];
}

const SEVERITY_ORDER = ["blocking", "should-fix", "later"] as const;

const SEVERITY_HEADING: Record<ReviewerFinding["severity"], string> = {
  blocking: "Blocking",
  "should-fix": "Worth fixing",
  later: "For later",
};

// A finding's `summary` and `suggestion` are model output shaped by
// arktype, but arktype only constrains the type, not the markdown it
// gets embedded into — and the model itself is reading attacker-supplied
// PR content (title, description, diff). A summary with an embedded
// newline can forge a fresh list item or heading; a suggestion with an
// embedded ``` can break out of its code fence into free-form review
// body. Neither is hypothetical: both are one crafted diff line away.
function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function fenceSafe(text: string): string {
  return text.replace(/```/g, "`​``");
}

function inlineCodeSafe(text: string): string {
  return text.replace(/`/g, "'");
}

function severityRank(severity: ReviewerFinding["severity"]): number {
  return SEVERITY_ORDER.indexOf(severity);
}

interface CollectedPasses {
  readonly findings: readonly AggregatedFinding[];
  readonly summaries: readonly { name: string; summary: string }[];
  readonly silent: readonly { name: string; reason: string }[];
}

function collect(
  passes: readonly ReviewerPass[],
  alreadyPosted: ReadonlySet<string>,
): CollectedPasses {
  const byFingerprint = new Map<
    string,
    { finding: ReviewerFinding; who: string[] }
  >();
  const summaries: { name: string; summary: string }[] = [];
  const silent: { name: string; reason: string }[] = [];

  for (const pass of passes) {
    const name = pass.reviewer.displayName;
    if (!pass.ok) {
      silent.push({ name, reason: pass.reason });
      continue;
    }
    const parsed = parseReviewerReport(pass.reply);
    if (!parsed.ok) {
      silent.push({ name, reason: parsed.reason });
      continue;
    }
    if (parsed.report.summary.trim().length > 0) {
      summaries.push({ name, summary: parsed.report.summary.trim() });
    }
    for (const finding of parsed.report.findings) {
      const fingerprint = fingerprintOf(finding);
      if (alreadyPosted.has(fingerprint)) continue;
      const existing = byFingerprint.get(fingerprint);
      if (existing === undefined) {
        byFingerprint.set(fingerprint, { finding, who: [name] });
        continue;
      }
      existing.who.push(name);
      if (
        severityRank(finding.severity) < severityRank(existing.finding.severity)
      ) {
        byFingerprint.set(fingerprint, { finding, who: existing.who });
      }
    }
  }

  const findings = [...byFingerprint.entries()]
    .map(([fingerprint, entry]) => ({
      finding: entry.finding,
      fingerprint,
      reviewers: entry.who,
    }))
    .sort(
      (left, right) =>
        severityRank(left.finding.severity) -
        severityRank(right.finding.severity),
    );
  return { findings, summaries, silent };
}

function anchorable(
  finding: ReviewerFinding,
  diff: PullRequestDiff,
): number | undefined {
  if (finding.line === undefined) return undefined;
  const file = diff.files.find((entry) => entry.path === finding.file);
  if (file === undefined) return undefined;
  return file.changedLines.includes(finding.line) ? finding.line : undefined;
}

function attribution(reviewers: readonly string[]): string {
  return reviewers.join(", ");
}

// The `suggestion` fence is a GitHub commit-suggestion: whatever text it
// wraps replaces the anchored line outright. Rendering `suggestedFix`
// there only makes sense once `existingCode` is verified against the
// diff — otherwise a model that wrote prose instead of code would ship
// as a broken, unreviewable "fix". A finding that fails the check keeps
// its text; it only drops the fence.
function rightHandLines(patch: string): string {
  return patch
    .split("\n")
    .filter((line) => !line.startsWith("-") && !line.startsWith("@@"))
    .map((line) =>
      line.startsWith("+") || line.startsWith(" ") ? line.slice(1) : line,
    )
    .join("\n");
}

function existingCodeAnchors(
  finding: ReviewerFinding,
  diff: PullRequestDiff,
): boolean {
  if (finding.existingCode === undefined) return false;
  const file = diff.files.find((entry) => entry.path === finding.file);
  if (file?.patch === undefined) return false;
  return rightHandLines(file.patch).includes(finding.existingCode.trim());
}

function bodyLine(entry: AggregatedFinding): string {
  const path = inlineCodeSafe(entry.finding.file);
  const where =
    entry.finding.line === undefined
      ? path
      : `${path}:${String(entry.finding.line)}`;
  return (
    `- \`${where}\` — ${singleLine(entry.finding.summary)} ` +
    `_(${attribution(entry.reviewers)})_ ` +
    fingerprintMarker(entry.fingerprint)
  );
}

function commentBody(entry: AggregatedFinding, diff: PullRequestDiff): string {
  const head =
    `**${SEVERITY_HEADING[entry.finding.severity]}** — ` +
    `${singleLine(entry.finding.summary)}\n\n_${attribution(entry.reviewers)}_`;
  const marker = fingerprintMarker(entry.fingerprint);
  if (
    entry.finding.suggestedFix === undefined ||
    !existingCodeAnchors(entry.finding, diff)
  ) {
    return `${head}\n\n${marker}`;
  }
  return (
    `${head}\n\n\`\`\`suggestion\n${fenceSafe(entry.finding.suggestedFix)}\n\`\`\`` +
    `\n\n${marker}`
  );
}

function countLine(findings: readonly AggregatedFinding[]): string {
  if (findings.length === 0) {
    return "No findings — the reviewers read the change and had nothing to raise.";
  }
  const counts = SEVERITY_ORDER.map((severity) => {
    const total = findings.filter(
      (entry) => entry.finding.severity === severity,
    ).length;
    return total === 0
      ? undefined
      : `${String(total)} ${SEVERITY_HEADING[severity].toLowerCase()}`;
  }).filter((part): part is string => part !== undefined);
  return `${counts.join(", ")}.`;
}

/**
 * Combines the reviewer passes into the one review that gets posted:
 * a markdown body covering every finding, plus inline comments for the
 * findings anchored to a line in the diff.
 */
export function aggregateReview(
  passes: readonly ReviewerPass[],
  diff: PullRequestDiff,
  alreadyPosted: ReadonlySet<string> = new Set(),
): PullRequestReviewDraft {
  const collected = collect(passes, alreadyPosted);
  const sections: string[] = [
    "## Code review",
    "",
    countLine(collected.findings),
  ];

  for (const severity of SEVERITY_ORDER) {
    const forSeverity = collected.findings.filter(
      (entry) => entry.finding.severity === severity,
    );
    if (forSeverity.length === 0) continue;
    sections.push("", `### ${SEVERITY_HEADING[severity]}`, "");
    sections.push(...forSeverity.map(bodyLine));
  }

  if (collected.summaries.length > 0) {
    sections.push("", "### What each reviewer looked at", "");
    sections.push(
      ...collected.summaries.map(
        (entry) => `- **${entry.name}** — ${singleLine(entry.summary)}`,
      ),
    );
  }

  if (collected.silent.length > 0) {
    sections.push("", "### Reviewers that did not report", "");
    sections.push(
      ...collected.silent.map(
        (entry) => `- **${entry.name}** — ${entry.reason}`,
      ),
    );
  }

  const comments: PullRequestReviewComment[] = [];
  for (const entry of collected.findings) {
    const line = anchorable(entry.finding, diff);
    if (line === undefined) continue;
    comments.push({
      path: entry.finding.file,
      line,
      body: commentBody(entry, diff),
    });
  }

  return { body: `${sections.join("\n")}\n`, comments };
}
