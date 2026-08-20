// The shell's layout mode, read from the same media queries the stylesheet
// would use rather than from a resize listener: the browser evaluates the
// query and fires `change` only when the answer actually changes, so a drag
// across the whole viewport produces two state updates instead of hundreds.
//
// Rendering to static markup (the route tests) never runs effects and has no
// `window`, so it sees the initial "expanded" assumption — which is what a
// server-rendered shell should assume before it has a viewport to measure.

import { useEffect, useState } from "react";

import {
  NARROW_MAX_WIDTH,
  COMPACT_MAX_WIDTH,
  shellLayoutModeFromMatches,
  type ShellLayoutMode,
} from "./breakpoints";

const NARROW_QUERY = `(max-width: ${NARROW_MAX_WIDTH - 1}px)`;
const COMPACT_QUERY = `(max-width: ${COMPACT_MAX_WIDTH - 1}px)`;

export function useShellLayoutMode(): ShellLayoutMode {
  const [mode, setMode] = useState<ShellLayoutMode>("expanded");

  useEffect(() => {
    const narrow = window.matchMedia(NARROW_QUERY);
    const compact = window.matchMedia(COMPACT_QUERY);
    const sync = () =>
      setMode(shellLayoutModeFromMatches(narrow.matches, compact.matches));
    sync();
    narrow.addEventListener("change", sync);
    compact.addEventListener("change", sync);
    return () => {
      narrow.removeEventListener("change", sync);
      compact.removeEventListener("change", sync);
    };
  }, []);

  return mode;
}
