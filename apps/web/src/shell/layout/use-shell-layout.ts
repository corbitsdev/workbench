// Media queries, not a resize listener: `change` fires only when the
// answer changes, so a full-viewport drag produces two updates, not
// hundreds.

import { useSyncExternalStore } from "react";

import {
  NARROW_MAX_WIDTH,
  COMPACT_MAX_WIDTH,
  shellLayoutModeFromMatches,
  type ShellLayoutMode,
} from "./breakpoints";

const NARROW_QUERY = `(max-width: ${NARROW_MAX_WIDTH - 1}px)`;
const COMPACT_QUERY = `(max-width: ${COMPACT_MAX_WIDTH - 1}px)`;

function subscribe(onChange: () => void): () => void {
  const narrow = window.matchMedia(NARROW_QUERY);
  const compact = window.matchMedia(COMPACT_QUERY);
  narrow.addEventListener("change", onChange);
  compact.addEventListener("change", onChange);
  return () => {
    narrow.removeEventListener("change", onChange);
    compact.removeEventListener("change", onChange);
  };
}

// The snapshot is the mode string itself, so repeated reads compare equal
// and never loop — a fresh object here would re-render forever.
function getSnapshot(): ShellLayoutMode {
  return shellLayoutModeFromMatches(
    window.matchMedia(NARROW_QUERY).matches,
    window.matchMedia(COMPACT_QUERY).matches,
  );
}

/** A viewport-less render (the route tests) gets the same "expanded"
 * assumption a server-rendered shell should make before it can measure. */
function getServerSnapshot(): ShellLayoutMode {
  return "expanded";
}

export function useShellLayoutMode(): ShellLayoutMode {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
