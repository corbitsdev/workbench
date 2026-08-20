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

function dedupeKey(finding: ReviewerFinding): string {
  const line = finding.line === undefined ? "" : String(finding.line);
  const summary = finding.summary.trim().toLowerCase().replace(/\s+/g, " ");
  return `${finding.file}:${line}:${summary}`;
}

function severityRank(severity: ReviewerFinding["severity"]): number {
  return SEVERITY_ORDER.indexOf(severity);
}

interface CollectedPasses {
  readonly findings: readonly AggregatedFinding[];
  readonly summaries: readonly { name: string; summary: string }[];
  readonly silent: readonly { name: string; reason: string }[];
}

function collect(passes: readonly ReviewerPass[]): CollectedPasses {
  const byKey = new Map<string, { finding: ReviewerFinding; who: string[] }>();
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
      const key = dedupeKey(finding);
      const existing = byKey.get(key);
      if (existing === undefined) {
        byKey.set(key, { finding, who: [name] });
        continue;
      }
      existing.who.push(name);
      if (
        severityRank(finding.severity) < severityRank(existing.finding.severity)
      ) {
        byKey.set(key, { finding, who: existing.who });
      }
    }
  }

  const findings = [...byKey.values()]
    .map((entry) => ({ finding: entry.finding, reviewers: entry.who }))
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

function bodyLine(entry: AggregatedFinding): string {
  const path = inlineCodeSafe(entry.finding.file);
  const where =
    entry.finding.line === undefined
      ? path
      : `${path}:${String(entry.finding.line)}`;
  return (
    `- \`${where}\` — ${singleLine(entry.finding.summary)} ` +
    `_(${attribution(entry.reviewers)})_`
  );
}

function commentBody(entry: AggregatedFinding): string {
  const head =
    `**${SEVERITY_HEADING[entry.finding.severity]}** — ` +
    `${singleLine(entry.finding.summary)}\n\n_${attribution(entry.reviewers)}_`;
  if (entry.finding.suggestion === undefined) return head;
  return `${head}\n\n\`\`\`suggestion\n${fenceSafe(entry.finding.suggestion)}\n\`\`\``;
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
): PullRequestReviewDraft {
  const collected = collect(passes);
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
      body: commentBody(entry),
    });
  }

  return { body: `${sections.join("\n")}\n`, comments };
}
