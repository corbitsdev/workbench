/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import { shouldShowArtifactStatusBadge } from "./artifact-status-badge";

describe("shouldShowArtifactStatusBadge", () => {
  it("hides the badge for the default draft status", () => {
    expect(shouldShowArtifactStatusBadge("draft")).toBe(false);
  });

  it("shows the badge for approved and rejected", () => {
    expect(shouldShowArtifactStatusBadge("approved")).toBe(true);
    expect(shouldShowArtifactStatusBadge("rejected")).toBe(true);
  });
});