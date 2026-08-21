// The stage top bar's per-page filter (DECISIONS.md → Search): a magnifier
// that morphs in place into a plain text input scoped to whatever the page
// is showing — Files filters files, Skills filters skills. It never reaches
// the global command palette; `Cmd+K` is a separate surface entirely
// (`command-palette-provider.tsx`), mounted on its own rather than out of
// this control.
//
// A page hands in the filter it already owns (`value`/`onChange`); this
// component only supplies the chrome — the button, the morph, and the input
// that drives that state directly. `StageTopBar` renders it only when a page
// passes a filter, so a page with nothing to filter shows no magnifier.
//
// Motion is the width transition authored on `.stage-search` in app.css
// (react-ui's `--duration-standard` and `--ease-in-out`). Reduced motion
// needs nothing here: react-ui's stylesheet already collapses every
// transition duration under `prefers-reduced-motion`.

import { MagnifyingGlass } from "@corbits/icons";
import { useEffect, useRef, useState } from "react";

export type StageSearchProps = {
  /** Accessible name for both the button and the input, and the default
   * placeholder — e.g. "Filter files". Never "Search …": this is a filter,
   * not the product's search surface. */
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
};

export function StageSearch({
  label,
  value,
  onChange,
  placeholder,
}: StageSearchProps) {
  const [open, setOpen] = useState(value.length > 0);
  const wasOpen = useRef(open);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // A query the page already carries in (a prefilled filter) keeps the bar
  // expanded even before anyone has focused it.
  const expanded = open || value.length > 0;

  useEffect(() => {
    if (open) inputRef.current?.focus();
    if (wasOpen.current && !open) buttonRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  return (
    <div
      className="stage-search"
      data-testid="stage-search"
      data-expanded={expanded}
    >
      <button
        ref={buttonRef}
        type="button"
        className="stage-search-button"
        aria-label={label}
        aria-expanded={expanded}
        onClick={() => setOpen(true)}
      >
        <MagnifyingGlass aria-hidden="true" />
      </button>
      {expanded ? (
        <input
          ref={inputRef}
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
            else setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}
