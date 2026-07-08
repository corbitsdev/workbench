import { describe, expect, it } from "bun:test";
import {
  isTransientLaunchError,
  isMissingConfigError,
  isLaunchableStatus,
  classifyLaunchState,
} from "./agent-launch-helpers";

describe("isTransientLaunchError", () => {
  it("treats sidecar startup races as transient", () => {
    expect(
      isTransientLaunchError(
        new Error('No sidecar connected for agent "ins_1"'),
      ),
    ).toBe(true);
    expect(
      isTransientLaunchError(
        new Error('No sidecar available for agent "ins_1"'),
      ),
    ).toBe(true);
    expect(isTransientLaunchError(new Error("sidecar not connected"))).toBe(
      true,
    );
    expect(isTransientLaunchError(new Error("sidecar not available"))).toBe(
      true,
    );
  });

  it("treats hub/sidecar restart errors (a redeploy) as transient", () => {
    for (const msg of [
      "502 Bad Gateway",
      "503 Service Unavailable",
      "504 Gateway Timeout",
      "agent is unreachable",
      "Failed to fetch",
      "NetworkError when attempting to fetch resource",
      "Load failed",
    ]) {
      expect(isTransientLaunchError(new Error(msg))).toBe(true);
    }
  });

  it("does not treat auth or config errors as transient", () => {
    expect(isTransientLaunchError(new Error("credential not found"))).toBe(
      false,
    );
    expect(
      isTransientLaunchError(new Error("agent definition not registered")),
    ).toBe(false);
  });

  it("accepts plain strings", () => {
    expect(isTransientLaunchError("No sidecar connected for ins_1")).toBe(true);
    expect(isTransientLaunchError("auth_failed")).toBe(false);
  });
});

describe("isMissingConfigError", () => {
  it("detects credential-related messages", () => {
    expect(isMissingConfigError(new Error("credential not found"))).toBe(true);
    expect(
      isMissingConfigError(
        new Error("No credential configured for this agent"),
      ),
    ).toBe(true);
    expect(isMissingConfigError(new Error("missing configuration"))).toBe(true);
    expect(isMissingConfigError(new Error("not configured"))).toBe(true);
  });

  it("does not classify transient or generic errors as missing config", () => {
    expect(isMissingConfigError(new Error("No sidecar connected"))).toBe(false);
    expect(isMissingConfigError(new Error("502 Bad Gateway"))).toBe(false);
    expect(isMissingConfigError(new Error("internal server error"))).toBe(
      false,
    );
  });
});

describe("isLaunchableStatus", () => {
  it("treats running, deployed, and undefined as launchable", () => {
    expect(isLaunchableStatus(undefined)).toBe(true);
    expect(isLaunchableStatus("running")).toBe(true);
    expect(isLaunchableStatus("deployed")).toBe(true);
  });

  it("treats stopped and provisioning as not launchable", () => {
    expect(isLaunchableStatus("stopped")).toBe(false);
    expect(isLaunchableStatus("provisioning")).toBe(false);
  });
});

describe("classifyLaunchState", () => {
  it("returns deploying when instance is not yet running", () => {
    const state = classifyLaunchState("provisioning", null);
    expect(state.kind).toBe("deploying");
  });

  it("returns deploying when instanceStatus is stopped", () => {
    const state = classifyLaunchState("stopped", null);
    expect(state.kind).toBe("deploying");
  });

  it("classifies a deployed instance by its launch error, not as deploying", () => {
    // A deployed instance is launchable, so the launch outcome drives the state.
    expect(classifyLaunchState("deployed", null).kind).toBe("connecting");
    expect(
      classifyLaunchState("deployed", "No sidecar available for agent ins_1")
        .kind,
    ).toBe("connecting");
    expect(classifyLaunchState("deployed", "credential not found").kind).toBe(
      "missing-config",
    );
    // A redeploy-time gateway error is transient, not fatal.
    expect(classifyLaunchState("deployed", "502 Bad Gateway").kind).toBe(
      "connecting",
    );
  });

  it("returns connecting when no error and status is running", () => {
    const state = classifyLaunchState("running", null);
    expect(state.kind).toBe("connecting");
  });

  it("returns connecting when status is undefined (assumed running)", () => {
    const state = classifyLaunchState(undefined, null);
    expect(state.kind).toBe("connecting");
  });

  it("returns connecting for transient sidecar errors", () => {
    const state = classifyLaunchState(
      undefined,
      "No sidecar connected for agent ins_1",
    );
    expect(state.kind).toBe("connecting");
  });

  it("returns missing-config for credential errors", () => {
    const state = classifyLaunchState(undefined, "credential not found");
    expect(state.kind).toBe("missing-config");
    if (state.kind === "missing-config") {
      expect(state.message).toBe("credential not found");
    }
  });

  it("returns fatal for unrecognised non-transient errors", () => {
    const state = classifyLaunchState(
      undefined,
      "agent definition not registered",
    );
    expect(state.kind).toBe("fatal");
    if (state.kind === "fatal") {
      expect(state.message).toBe("agent definition not registered");
    }
  });

  it("deploying takes precedence over launchError when instance is not running", () => {
    // If the instance hasn't reached running status, we always show deploying
    // regardless of whether there's also a launch error.
    const state = classifyLaunchState(
      "provisioning",
      "agent definition not registered",
    );
    expect(state.kind).toBe("deploying");
  });
});
