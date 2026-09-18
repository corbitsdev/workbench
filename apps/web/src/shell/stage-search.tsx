// Never reaches the global command palette — `Cmd+K` is a separate
// surface, mounted on its own.

// Chrome only: a page hands in the filter it already owns. `StageTopBar`
// renders this only when a page passes a filter.

import { MagnifyingGlass } from "@/lib/icons";
import { useRef, useState } from "react";

export type StageSearchProps = {
  /** Accessible name for both the button and the input, and the default
   * placeholder — e.g. "Filter files". Never "Search …": this is a filter,
   * not the product's search surface. */
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
};

export function StageSearch({ label, value, onChange, placeholder }: StageSearchProps) {
  const [open, setOpen] = useState(value.length > 0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Set only by the button, so a prefilled filter expands the bar without
  // stealing focus from whatever the page opened with.
  const openedByClick = useRef(false);
  // A query the page already carries in (a prefilled filter) keeps the bar
  // expanded even before anyone has focused it.
  const expanded = open || value.length > 0;

  function collapse() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  return (
    <div className="stage-search" data-testid="stage-search" data-expanded={expanded}>
      <button
        ref={buttonRef}
        type="button"
        className="stage-search-button"
        aria-label={label}
        aria-expanded={expanded}
        onClick={() => {
          openedByClick.current = true;
          setOpen(true);
        }}
      >
        <MagnifyingGlass aria-hidden="true" />
      </button>
      {expanded ? (
        <input
          ref={(node) => {
            if (node === null || !openedByClick.current) return;
            openedByClick.current = false;
            node.focus();
          }}
          type="search"
          className="stage-search-input"
          aria-label={label}
          placeholder={placeholder ?? label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={() => {
            if (value.length === 0) setOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            if (value.length > 0) onChange("");
            else collapse();
          }}
        />
      ) : null}
    </div>
  );
}
