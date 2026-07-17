/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type { TimelineEntry } from "@workbench/client";
import {
  PermissionCaveatBanner,
  hasPermissionEntry,
} from "./PermissionCaveatBanner";

function entry(kind: string): TimelineEntry {
  return {
    kind,
    id: `${kind}-1`,
    sourceTable: kind,
    timestamp: "2026-07-01T10:00:00.000Z",
    summary: null,
  } as unknown as TimelineEntry;
}

afterEach(() => {
  cleanup();
});

describe("PermissionCaveatBanner", () => {
  it("detects grant and credential entries among others", () => {
    expect(hasPermissionEntry([entry("workflow_run")])).toBe(false);
    expect(hasPermissionEntry([entry("workflow_run"), entry("grant")])).toBe(
      true,
    );
    expect(hasPermissionEntry([entry("credential")])).toBe(true);
    expect(hasPermissionEntry([])).toBe(false);
  });

  it("renders the canonical audit-history caveat when a permission entry is present", () => {
    render(<PermissionCaveatBanner entries={[entry("grant")]} />);
    expect(screen.getByTestId("permission-caveat").textContent).toMatch(
      /not an audit history for permissions or credentials/i,
    );
  });

  it("renders nothing when no grant or credential entry is present", () => {
    const { container } = render(
      <PermissionCaveatBanner entries={[entry("message")]} />,
    );
    expect(screen.queryByTestId("permission-caveat")).toBeNull();
    expect(container.firstChild).toBeNull();
  });
});
