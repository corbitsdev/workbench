// The one way into search from chrome (DESIGN.md → Search): a magnifier that
// morphs in place into an inline bar and hands the query to the command
// palette — the product's single search surface. There is no second search
// implementation behind this control; it opens the same palette cmd+K does,
// and its expanded/collapsed state IS the palette's open state
// (`command-palette-open-store`), so the two can never disagree.
//
// The palette itself is react-ui's non-modal `CommandPaletteInline`: the
// field it renders IS the real, focusable search input, anchored to this
// control, with its results hanging directly beneath — never a centered
// dialog the magnifier merely opens. `leading` carries the magnifier button
// itself, so the collapsed control and the expanded bar are one continuous
// element rather than a button and a separate window.
//
// Motion is the width transition authored on `.stage-search` in app.css
// (react-ui's `--duration-standard` and `--ease-in-out`, the curve its
// theme documents for something growing in place). Reduced motion needs
// nothing here: react-ui's stylesheet already collapses every transition
// duration under `prefers-reduced-motion`, which makes the swap instant.

import { MagnifyingGlass } from "@corbits/icons";
import { CommandPaletteInline } from "@corbits/react-ui";
import { useEffect, useRef } from "react";

import { useCommandPaletteRender } from "../command-palette-provider";
import {
  openCommandPalette,
  setCommandPaletteOpen,
  setCommandPaletteQuery,
  useCommandPaletteOpen,
  useCommandPaletteQuery,
} from "../command-palette-open-store";

export function StageSearch() {
  const open = useCommandPaletteOpen();
  const query = useCommandPaletteQuery();
  const render = useCommandPaletteRender();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  // Whichever way the palette closed — Escape, an outside click, the
  // store — focus comes back to the control the morph came out of, instead
  // of being dropped on the document.
  useEffect(() => {
    if (wasOpen.current && !open) buttonRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  return (
    <div
      className="stage-search"
      data-testid="stage-search"
      data-expanded={open}
    >
      <CommandPaletteInline
        open={open}
        onOpenChange={setCommandPaletteOpen}
        query={query}
        onQueryChange={setCommandPaletteQuery}
        groups={render.groups}
        onSelect={render.onSelect}
        loading={render.loading}
        error={render.error}
        hasMore={render.hasMore}
        onLoadMore={render.onLoadMore}
        placeholder="Search agents, skills, files, actions…"
        footer={render.footer}
        leading={
          <button
            ref={buttonRef}
            type="button"
            className="stage-search-button"
            aria-label="Search"
            aria-expanded={open}
            aria-keyshortcuts="Meta+K Control+K"
            onClick={openCommandPalette}
          >
            <MagnifyingGlass aria-hidden="true" />
          </button>
        }
      />
    </div>
  );
}
