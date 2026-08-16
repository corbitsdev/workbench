// The first tests in this package that need a live DOM: `useShellLayoutMode`
// subscribes to media queries, and that behaviour does not exist under
// `renderToStaticMarkup` — effects never run
// there. `test/dom-setup.ts` (preloaded via bunfig.toml) supplies the DOM;
// `window.matchMedia` is stubbed here because the point is to control when a
// query flips, which resizing a simulated viewport cannot do
// deterministically.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  COMPACT_MAX_WIDTH,
  NARROW_MAX_WIDTH,
  type ShellLayoutMode,
} from "../src/breakpoints";
import { useShellLayoutMode } from "../src/use-shell-layout";

type StubQuery = {
  matches: boolean;
  readonly media: string;
  readonly listeners: Set<() => void>;
  readonly addEventListener: (type: string, listener: () => void) => void;
  readonly removeEventListener: (type: string, listener: () => void) => void;
};

const queries = new Map<string, StubQuery>();

function createStubQuery(media: string): StubQuery {
  const listeners = new Set<() => void>();
  return {
    matches: false,
    media,
    listeners,
    addEventListener: (_type: string, listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: () => void) => {
      listeners.delete(listener);
    },
  };
}

function stubMatchMedia(): void {
  queries.clear();
  window.matchMedia = ((media: string) => {
    const existing = queries.get(media);
    if (existing !== undefined) return existing as unknown as MediaQueryList;
    const query = createStubQuery(media);
    queries.set(media, query);
    return query as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
}

function queryFor(maxWidth: number): StubQuery {
  const query = queries.get(`(max-width: ${maxWidth - 1}px)`);
  if (query === undefined) throw new Error(`query for ${maxWidth} not created`);
  return query;
}

function setMatches(maxWidth: number, matches: boolean): void {
  const query = queryFor(maxWidth);
  query.matches = matches;
  act(() => {
    for (const listener of query.listeners) listener();
  });
}

let container: HTMLDivElement;
let root: Root;
let observed: ShellLayoutMode | null = null;

function Probe() {
  observed = useShellLayoutMode();
  return null;
}

function mountProbe(): void {
  act(() => {
    root.render(<Probe />);
  });
}

beforeEach(() => {
  stubMatchMedia();
  observed = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useShellLayoutMode", () => {
  test("subscribes to both breakpoints, once each", () => {
    mountProbe();
    expect(queryFor(NARROW_MAX_WIDTH).listeners.size).toBe(1);
    expect(queryFor(COMPACT_MAX_WIDTH).listeners.size).toBe(1);
  });

  test("reads the queries on mount rather than waiting for a change event", () => {
    stubMatchMedia();
    window.matchMedia(`(max-width: ${NARROW_MAX_WIDTH - 1}px)`);
    queryFor(NARROW_MAX_WIDTH).matches = true;
    window.matchMedia(`(max-width: ${COMPACT_MAX_WIDTH - 1}px)`);
    queryFor(COMPACT_MAX_WIDTH).matches = true;
    mountProbe();
    expect(observed).toBe("narrow");
  });

  test("follows the viewport across every mode", () => {
    mountProbe();
    expect(observed).toBe("expanded");
    setMatches(COMPACT_MAX_WIDTH, true);
    expect(observed).toBe("compact");
    setMatches(NARROW_MAX_WIDTH, true);
    expect(observed).toBe("narrow");
    setMatches(NARROW_MAX_WIDTH, false);
    expect(observed).toBe("compact");
    setMatches(COMPACT_MAX_WIDTH, false);
    expect(observed).toBe("expanded");
  });

  test("drops both listeners when the shell unmounts", () => {
    mountProbe();
    act(() => root.render(null));
    expect(queryFor(NARROW_MAX_WIDTH).listeners.size).toBe(0);
    expect(queryFor(COMPACT_MAX_WIDTH).listeners.size).toBe(0);
  });
});
