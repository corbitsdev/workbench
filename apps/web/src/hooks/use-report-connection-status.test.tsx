/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ConnectionStatusProvider } from "../lib/connection-status-context";
import type { MyraPhase } from "../lib/connection-status";
import {
  installFakeTimers,
  type FakeTimers,
} from "../test-support/fake-timers";
import { useReportConnectionStatus } from "./use-report-connection-status";

function Harness({
  phase,
  reconnect,
  identity = "tenant-1:inst-1",
}: {
  phase: MyraPhase;
  reconnect: () => void;
  identity?: string | null;
}) {
  useReportConnectionStatus(phase, true, reconnect, identity);
  return null;
}

const renderHarness = (props: {
  phase: MyraPhase;
  reconnect: () => void;
  identity?: string | null;
}) => (
  <ConnectionStatusProvider>
    <Harness {...props} />
  </ConnectionStatusProvider>
);

afterEach(cleanup);

describe("useReportConnectionStatus — auto reconnect", () => {
  it("fires one reconnect when a ready session first errors, and no more", () => {
    const reconnect = mock(() => {});
    const { rerender } = render(renderHarness({ phase: "ready", reconnect }));
    expect(reconnect).not.toHaveBeenCalled();

    rerender(renderHarness({ phase: "error", reconnect }));
    expect(reconnect).toHaveBeenCalledTimes(1);

    // A second consecutive error must not loop the reconnect.
    rerender(renderHarness({ phase: "error", reconnect }));
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("does not reconnect on an initial load that never reached ready", () => {
    const reconnect = mock(() => {});
    render(renderHarness({ phase: "error", reconnect }));
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("does not treat a session identity change (thread switch) as a drop", () => {
    const reconnect = mock(() => {});
    const { rerender } = render(
      renderHarness({ phase: "ready", reconnect, identity: "t:inst-a" }),
    );
    // Switch to a different instance, which re-enters loading: this is
    // navigation, not a dropped session — no auto-reconnect.
    rerender(
      renderHarness({ phase: "loading", reconnect, identity: "t:inst-b" }),
    );
    expect(reconnect).not.toHaveBeenCalled();
  });
});

describe("useReportConnectionStatus — overlay visibility", () => {
  let timers: FakeTimers;
  beforeEach(() => {
    timers = installFakeTimers();
  });
  afterEach(() => {
    timers.restore();
  });
  const advance = (ms: number) => act(() => timers.advance(ms));

  it("covers the app only after a dropped session persists past the debounce", () => {
    const reconnect = mock(() => {});
    const { rerender } = render(renderHarness({ phase: "ready", reconnect }));
    rerender(renderHarness({ phase: "loading", reconnect }));
    // Still hidden right after the drop — a brief blip must not flash it.
    expect(screen.queryByRole("status")).toBeNull();
    advance(2500);
    expect(
      screen.getByRole("status", { name: "Updating Workbench" }),
    ).toBeTruthy();
  });

  it("stays hidden for an initial load that has never been ready", () => {
    const reconnect = mock(() => {});
    render(renderHarness({ phase: "loading", reconnect }));
    advance(5000);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("does not cover the app when switching threads after a ready session", () => {
    const reconnect = mock(() => {});
    const { rerender } = render(
      renderHarness({ phase: "ready", reconnect, identity: "t:inst-a" }),
    );
    rerender(
      renderHarness({ phase: "loading", reconnect, identity: "t:inst-b" }),
    );
    advance(5000);
    expect(screen.queryByRole("status")).toBeNull();
  });

});
