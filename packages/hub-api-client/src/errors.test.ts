import { describe, expect, test } from "bun:test";
import {
  HubApiError,
  isHubApiError,
  isSidecarUnavailableError,
  SidecarUnavailableError,
} from "./errors";

describe("HubApiError", () => {
  test("carries the problem as its message and the fix separately", () => {
    const error = new HubApiError("the hub is unreachable", "start it first");
    expect(error.message).toBe("the hub is unreachable");
    expect(error.fix).toBe("start it first");
    expect(error.name).toBe("HubApiError");
  });

  test("isHubApiError narrows only actual HubApiError instances", () => {
    expect(isHubApiError(new HubApiError("x", "y"))).toBe(true);
    expect(isHubApiError(new Error("plain"))).toBe(false);
    expect(isHubApiError("not an error")).toBe(false);
  });
});

describe("SidecarUnavailableError", () => {
  test("is a HubApiError with its own distinct name", () => {
    const error = new SidecarUnavailableError("sidecar down", "wait and retry");
    expect(error).toBeInstanceOf(HubApiError);
    expect(error.name).toBe("SidecarUnavailableError");
    expect(isHubApiError(error)).toBe(true);
  });

  test("isSidecarUnavailableError rejects a generic HubApiError", () => {
    expect(
      isSidecarUnavailableError(new SidecarUnavailableError("x", "y")),
    ).toBe(true);
    expect(isSidecarUnavailableError(new HubApiError("x", "y"))).toBe(false);
  });
});
