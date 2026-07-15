/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import { useMemo, useRef } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import {
  PageChromeProvider,
  usePageChromeSlot,
  useSetPageChrome,
} from "./page-chrome";

function Slot() {
  const chrome = usePageChromeSlot();
  return <header data-testid="slot">{chrome}</header>;
}

describe("useSetPageChrome", () => {
  it("renders the published chrome in the slot", async () => {
    function Publisher() {
      const node = useMemo(() => <span>insights header</span>, []);
      useSetPageChrome(node);
      return null;
    }
    render(
      <PageChromeProvider>
        <Slot />
        <Publisher />
      </PageChromeProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText("insights header")).toBeTruthy();
    });
  });

  it("clears the slot when the publisher unmounts", async () => {
    function Publisher() {
      const node = useMemo(() => <span>gone soon</span>, []);
      useSetPageChrome(node);
      return null;
    }
    const view = render(
      <PageChromeProvider>
        <Slot />
        <Publisher />
      </PageChromeProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText("gone soon")).toBeTruthy();
    });
    view.rerender(
      <PageChromeProvider>
        <Slot />
      </PageChromeProvider>,
    );
    await waitFor(() => {
      expect(screen.queryByText("gone soon")).toBeNull();
    });
  });

  it("publishing does not re-render the publisher", async () => {
    const renders = { count: 0 };
    function Publisher() {
      renders.count += 1;
      const node = useMemo(() => <span>stable header</span>, []);
      useSetPageChrome(node);
      return null;
    }
    render(
      <PageChromeProvider>
        <Slot />
        <Publisher />
      </PageChromeProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText("stable header")).toBeTruthy();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(renders.count).toBe(1);
  });

  it("a publisher with an unstable chrome node does not loop", async () => {
    // Regression: the publisher used to consume the same context its publish
    // mutates, so an unstable node identity re-rendered the publisher, which
    // rebuilt the node, which re-published — an unbounded update loop that
    // starves router navigation transitions. The publisher below rebuilds its
    // node on every render (the InsightsDashboard shape); it caps itself so a
    // regression fails the assertion instead of hanging the test run.
    const renders = { count: 0 };
    function Publisher() {
      renders.count += 1;
      const capped = useRef(false);
      if (renders.count > 25) capped.current = true;
      const node = capped.current ? null : <span>unstable {"header"}</span>;
      useSetPageChrome(node);
      return null;
    }
    render(
      <PageChromeProvider>
        <Slot />
        <Publisher />
      </PageChromeProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText(/unstable/)).toBeTruthy();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renders.count).toBeLessThanOrEqual(2);
  });
});
