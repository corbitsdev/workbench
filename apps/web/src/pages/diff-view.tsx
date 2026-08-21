// One diff renderer for every surface that shows "what changed": the
// save-confirmation step and the version comparison on a detail page both
// mount this, so a diff always reads the same way. The line script comes
// from `@corbits/text-diff`; this file is only its presentation, and it
// computes the script exactly once per render — the change summary is read
// off the same result the rows come from.

import {
  Badge,
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@corbits/react-ui";
import { diffText } from "@corbits/text-diff";
import type { DiffLine } from "@corbits/text-diff";
import { useMemo } from "react";

const MARKER: Record<DiffLine["kind"], string> = {
  context: " ",
  added: "+",
  removed: "-",
  skipped: "⋯",
};

const ROW_CLASS: Record<DiffLine["kind"], string> = {
  context: "text-muted-foreground",
  added: "bg-success/10 text-foreground",
  removed: "bg-destructive/10 text-foreground",
  skipped: "text-muted-foreground italic",
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
      <p className="text-sm text-muted-foreground" data-testid="diff-unchanged">
        {unchangedNotice}
      </p>
    );
  }

  if (diff.status === "too-large") {
    return (
      <div className="flex flex-col gap-1" data-testid="diff-too-large">
        <p className="text-sm text-foreground">
          This change is too large to show line by line — showing a summary
          only.
        </p>
        <p className="font-mono text-xs tabular-nums text-muted-foreground">
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
    <div className="flex flex-col gap-2" data-testid="diff-view">
      <p className="font-mono text-xs tabular-nums text-muted-foreground">
        {`+${String(diff.totals.added)} added, −${String(
          diff.totals.removed,
        )} removed`}
      </p>
      <div className="max-h-96 overflow-auto rounded-md border border-border bg-muted/30">
        <Table className="w-full border-collapse font-mono text-xs leading-relaxed">
          <TableBody>
            {diff.lines.map((line, index) => (
              <TableRow
                key={`${String(index)}:${line.kind}`}
                className={`${ROW_CLASS[line.kind]} border-b-0 hover:bg-transparent`}
              >
                <TableCell className="w-10 select-none px-2 text-right tabular-nums text-muted-foreground">
                  {lineNumber(line.beforeLineNumber)}
                </TableCell>
                <TableCell className="w-10 select-none px-2 text-right tabular-nums text-muted-foreground">
                  {lineNumber(line.afterLineNumber)}
                </TableCell>
                <TableCell className="w-6 select-none px-1 text-center">
                  {MARKER[line.kind]}
                </TableCell>
                <TableCell className="whitespace-pre-wrap break-words px-2 py-0.5">
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
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Badge tone="neutral">{beforeLabel}</Badge>
      <span aria-hidden="true" className="text-muted-foreground">
        →
      </span>
      <Badge tone="info">{afterLabel}</Badge>
    </div>
  );
}
