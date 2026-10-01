// Computes the diff script exactly once per render — the change summary
// reads off the same result the rows come from.

import { Badge, Table, TableBody, TableCell, TableRow } from "@corbits/react-ui";
import { diffText } from "@/lib/text-diff";
import type { DiffLine } from "@/lib/text-diff";
import { ArrowRight, DotsThree } from "@/lib/icons";
import { useMemo, type ReactNode } from "react";
import "./diff-view.css";

const MARKER: Record<DiffLine["kind"], ReactNode> = {
  context: " ",
  added: "+",
  removed: "-",
  skipped: <DotsThree aria-hidden="true" className="diff-skip-marker" />,
};

const ROW_CLASS: Record<DiffLine["kind"], string> = {
  context: "diff-row diff-row-context",
  added: "diff-row diff-row-added",
  removed: "diff-row diff-row-removed",
  skipped: "diff-row diff-row-skipped",
};

function lineNumber(value: number | null): string {
  return value === null ? "" : String(value);
}

export function DiffView({
  before,
  after,
  unchangedNotice = "No changes yet.",
}: {
  readonly before: string;
  readonly after: string;
  readonly unchangedNotice?: string;
}) {
  const diff = useMemo(() => diffText(before, after), [before, after]);

  if (diff.status === "identical") {
    return (
      <p className="page-note" data-testid="diff-unchanged">
        {unchangedNotice}
      </p>
    );
  }

  if (diff.status === "too-large") {
    return (
      <div className="diff-summary" data-testid="diff-too-large">
        <p className="diff-summary-text">
          This change is too large to show line by line — showing a summary only.
        </p>
        <p className="diff-counts">
          {`${String(diff.beforeLines)} lines before, ${String(
            diff.afterLines,
          )} after — ${String(diff.changedBeforeLines)} rewritten to ${String(
            diff.changedAfterLines,
          )}`}
        </p>
      </div>
    );
  }

  return (
    <div className="diff-view" data-testid="diff-view">
      <p className="diff-counts">
        {`+${String(diff.totals.added)} added, −${String(diff.totals.removed)} removed`}
      </p>
      <div className="diff-scroll">
        <Table className="diff-table">
          <TableBody>
            {diff.lines.map((line, index) => (
              <TableRow key={`${String(index)}:${line.kind}`} className={ROW_CLASS[line.kind]}>
                <TableCell className="diff-cell diff-cell-number">
                  {lineNumber(line.beforeLineNumber)}
                </TableCell>
                <TableCell className="diff-cell diff-cell-number">
                  {lineNumber(line.afterLineNumber)}
                </TableCell>
                <TableCell className="diff-cell diff-cell-marker">{MARKER[line.kind]}</TableCell>
                <TableCell className="diff-cell diff-cell-text">
                  {line.text === "" ? " " : line.text}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export function DiffHeading({
  beforeLabel,
  afterLabel,
}: {
  readonly beforeLabel: string;
  readonly afterLabel: string;
}) {
  return (
    <div className="diff-heading">
      <Badge tone="neutral">{beforeLabel}</Badge>
      <ArrowRight aria-hidden="true" className="diff-heading-arrow" />
      <Badge tone="info">{afterLabel}</Badge>
    </div>
  );
}
