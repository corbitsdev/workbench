// The one way into search from chrome (DESIGN.md → Search): a magnifier that
// morphs in place into an inline bar and hands the query to the command
// palette — the product's single search surface. There is no second search
// implementation behind this control; it opens the same palette cmd+K does,
// and its expanded/collapsed state IS the palette's open state
// (`command-palette-open-store`), so the two can never disagree.
//
// The palette itself is react-ui's modal `CommandPalette`, which owns the
// editable input once open. The bar this expands into therefore *shows* the
// live query rather than pretending to accept one — a span styled as a
// field, never a second input a click could land in and a screen reader
// would have to explain. An anchored, non-modal palette in react-ui would
// let this bar be the input itself; until then, showing is the honest shape.
//
// Motion is the width transition authored on `.stage-search` in app.css
// (react-ui's `--duration-standard` and `--ease-in-out`, the curve its
// theme documents for something growing in place). Reduced motion needs
// nothing here: react-ui's stylesheet already collapses every transition
// duration under `prefers-reduced-motion`, which makes the swap instant.

import { MagnifyingGlass } from "@corbits/icons";
import { useEffect, useRef } from "react";

import {
  openCommandPalette,
  useCommandPaletteOpen,
  useCommandPaletteQuery,
} from "../command-palette-open-store";

export function StageSearch() {
  const expanded = useCommandPaletteOpen();
  const query = useCommandPaletteQuery();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wasExpanded = useRef(false);

  // Whichever way the palette closed — Escape inside its dialog, a click on
  // its overlay, the store — focus comes back to the control the morph came
  // out of, instead of being dropped on the document.
  useEffect(() => {
    if (wasExpanded.current && !expanded) buttonRef.current?.focus();
    wasExpanded.current = expanded;
  }, [expanded]);

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
        aria-label="Search"
        aria-expanded={expanded}
        aria-keyshortcuts="Meta+K Control+K"
        onClick={openCommandPalette}
      >
        <MagnifyingGlass aria-hidden="true" />
      </button>
      {expanded ? (
        <span
          className="stage-search-field"
          data-testid="stage-search-field"
          data-placeholder={query === ""}
        >
          {query === "" ? "Search or jump to…" : query}
        </span>
      ) : null}
    </div>
  );
}
