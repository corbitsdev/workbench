// One diff renderer for every surface that shows "what changed": the
// save-confirmation step and the version comparison on a detail page both
// mount this, so a diff always reads the same way. The line script itself
// comes from `@corbits/text-diff`; this file is only its presentation.

import { Badge } from "@corbits/react-ui";
import { diffLines, diffTotals, hasChanges } from "@corbits/text-diff";
import type { DiffLine } from "@corbits/text-diff";

const MARKER: Record<DiffLine["kind"], string> = {
  context: " ",
  added: "+",
  removed: "-",
};

const ROW_CLASS: Record<DiffLine["kind"], string> = {
  context: "text-muted-foreground",
  added: "bg-success/10 text-foreground",
  removed: "bg-destructive/10 text-foreground",
};

function lineNumber(value: number | null): string {
  return value === null ? "" : String(value);
}

export function DiffSummary({
  before,
  after,
}: {
  readonly before: string;
  readonly after: string;
}) {
  const totals = diffTotals(diffLines(before, after));
  return (
    <p className="font-mono text-xs tabular-nums text-muted-foreground">
      {`+${String(totals.added)} added, −${String(totals.removed)} removed`}
    </p>
  );
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
  const lines = diffLines(before, after);

  if (!hasChanges(lines)) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="diff-unchanged">
        {unchangedNotice}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="diff-view">
      <DiffSummary before={before} after={after} />
      <div className="overflow-x-auto rounded-md border border-border bg-muted/30">
        <table className="w-full border-collapse font-mono text-xs leading-relaxed">
          <tbody>
            {lines.map((line, index) => (
              <tr
                key={`${String(index)}:${line.kind}`}
                className={ROW_CLASS[line.kind]}
              >
                <td className="w-10 select-none px-2 text-right tabular-nums text-muted-foreground">
                  {lineNumber(line.beforeLineNumber)}
                </td>
                <td className="w-10 select-none px-2 text-right tabular-nums text-muted-foreground">
                  {lineNumber(line.afterLineNumber)}
                </td>
                <td className="w-6 select-none px-1 text-center">
                  {MARKER[line.kind]}
                </td>
                <td className="whitespace-pre-wrap break-words px-2 py-0.5">
                  {line.text === "" ? " " : line.text}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
