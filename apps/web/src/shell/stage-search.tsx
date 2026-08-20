// The one way into search from chrome (DESIGN.md → Search): a magnifier that
// morphs in place into an inline bar and hands the query to the command
// palette — the product's single search surface. There is no second search
// implementation behind this control; it opens the same palette cmd+K does,
// and its expanded/collapsed state IS the palette's open state
// (`command-palette-open-store`), so the two can never disagree.
//
// The palette itself is react-ui's modal `CommandPalette`, which owns the
// editable input once open. The bar this file expands into therefore mirrors
// the live query rather than accepting keystrokes: one editable search field
// in the product, with the morph showing where the overlay came from. An
// anchored, non-modal palette in react-ui would let this bar be the input
// itself — until then, mirroring is the honest shape.
//
// Motion is the shell's own width transition on react-ui's motion tokens
// (`--duration-standard`, `--ease-spring`). Under `prefers-reduced-motion`
// the transition is not declared at all, so the swap is instant.

import { MagnifyingGlass } from "@corbits/icons";
import { usePrefersReducedMotion } from "@corbits/react-ui";
import { useRef } from "react";

import {
  openCommandPalette,
  setCommandPaletteOpen,
  useCommandPaletteOpen,
  useCommandPaletteQuery,
} from "../command-palette-open-store";

const MORPH_CLASS = "transition-[width] duration-standard ease-spring";

export function StageSearch() {
  const expanded = useCommandPaletteOpen();
  const query = useCommandPaletteQuery();
  const reducedMotion = usePrefersReducedMotion();
  const buttonRef = useRef<HTMLButtonElement>(null);

  return (
    <div
      className={reducedMotion ? "stage-search" : `stage-search ${MORPH_CLASS}`}
      data-testid="stage-search"
      data-expanded={expanded}
      data-motion={reducedMotion ? "instant" : "morph"}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        setCommandPaletteOpen(false);
        buttonRef.current?.focus();
      }}
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
        <input
          className="stage-search-field"
          data-testid="stage-search-input"
          type="text"
          value={query}
          placeholder="Search or jump to…"
          readOnly
          tabIndex={-1}
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
}
