import { Button } from "./Button";

export interface PaginationProps {
  page: number;
  totalPages: number;
  total: number;
  onPageChange: (page: number) => void;
}

/**
 * Server-side pagination control: Prev/Next around a "Page X of Y · N total"
 * legend. Presentation-only — the parent owns the page state and refetches on
 * change. Renders nothing when there is a single page or no rows, so a list
 * that fits on one page shows no chrome.
 */
export function Pagination({
  page,
  totalPages,
  total,
  onPageChange,
}: PaginationProps) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-sm text-text-2">
      <span>
        Page {page} of {totalPages}
        <span className="text-text-3"> · {total} total</span>
      </span>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          className="min-h-10"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          Previous
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="min-h-10"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
