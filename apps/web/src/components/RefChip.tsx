import { Link } from "react-router";
import { ExternalLink } from "lucide-react";
import {
  defaultRefLabel,
  isExternalMailboxRef,
  mailboxRefHref,
  type MailboxRef,
} from "@workbench/shared";

// One "Related" chip, shared verbatim by the inbox reading pane and the
// notifications bell so the two surfaces render refs identically. The label
// always comes from the ref's own `label` or the shared `defaultRefLabel` — a
// raw enum kind is never shown to the user. Sizing is fixed here (a single
// min-h-[40px] pill) so both surfaces get the same, comfortable hit target;
// adjacent chips are spaced by their container's `gap`, never overlapping.
const CHIP_CLASS =
  "inline-flex min-h-[40px] items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-text-2 transition-colors hover:bg-row-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange";

export function RefChip({
  refItem,
  onSelect,
}: {
  refItem: MailboxRef;
  onSelect?: () => void;
}) {
  const label = refItem.label ?? defaultRefLabel(refItem);
  if (isExternalMailboxRef(refItem)) {
    return (
      <a
        href={mailboxRefHref(refItem)}
        target="_blank"
        rel="noreferrer"
        onClick={onSelect}
        className={CHIP_CLASS}
      >
        {label}
        <ExternalLink size={12} aria-hidden="true" />
        <span className="sr-only">(opens in new tab)</span>
      </a>
    );
  }
  return (
    <Link
      to={mailboxRefHref(refItem)}
      onClick={onSelect}
      className={CHIP_CLASS}
    >
      {label}
    </Link>
  );
}
