// WORKBENCH-LOCAL (CL-2662): workbench-added coverage; upstream @intx/hub-agent
// has no sidecar-orchestrator test file at the 13fb9ac pin.
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { InferenceEvent } from "@intx/types/runtime";

const warnSpy = mock(() => {});

mock.module("@intx/log", () => ({
  getLogger: () => ({
    info: () => {},
    warn: warnSpy,
    error: () => {},
    debug: () => {},
  }),
}));

mock.module("./agent-repo-store", () => ({
  createAgentRepoStore: () => ({ repo: true }),
}));

mock.module("./agent-key-store", () => ({
  createAgentKeyStore: () => ({ key: true }),
}));

mock.module("./session-manager", () => ({
  createSessionManager: () => ({}),
}));

const sendEvent = mock(() => {});

mock.module("./ws/hub-link", () => ({
  createHubLink: () => ({
    connect: () => {},
    close: () => {},
    sendEvent,
  }),
}));

const { createSidecarOrchestrator } = await import("./sidecar-orchestrator");

type Deps = Parameters<
  NonNullable<
    Parameters<typeof createSidecarOrchestrator>[0]["createDeployRouter"]
  >
>[0];

function baseConfig(captureDeps: (deps: Deps) => void) {
  return {
    hubURL: "wss://hub",
    sidecarId: "sc1",
    token: "tok",
    dataDir: "/data",
    transport: {} as never,
    cryptoOps: {
      generateKeyPair: async () => ({}) as never,
      signEd25519: () => new Uint8Array(),
      verifySSHSig: () => true,
    },
    createDeployRouter: (deps: Deps) => {
      captureDeps(deps);
      return (() => {}) as never;
    },
  };
}

const event = { type: "inference.start" } as unknown as InferenceEvent;

describe("createSidecarOrchestrator publishWorkflowInferenceEvent", () => {
  afterEach(() => {
    sendEvent.mockClear();
    warnSpy.mockClear();
  });

  test("exposes publishWorkflowInferenceEvent on deploy router deps", () => {
    let captured: Deps | undefined;
    createSidecarOrchestrator(baseConfig((d) => (captured = d)) as never);
    expect(typeof captured?.publishWorkflowInferenceEvent).toBe("function");
  });

  test("routes an event with a session id through the hub-link sendEvent sink", () => {
    let captured: Deps | undefined;
    createSidecarOrchestrator(baseConfig((d) => (captured = d)) as never);
    captured?.publishWorkflowInferenceEvent("agent@x", event, "ses_1");
    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect(sendEvent).toHaveBeenCalledWith("agent@x", "ses_1", event);
  });

  test("drops a sessionless event and warns instead of dispatching", () => {
    let captured: Deps | undefined;
    createSidecarOrchestrator(baseConfig((d) => (captured = d)) as never);
    captured?.publishWorkflowInferenceEvent("agent@x", event, undefined);
    expect(sendEvent).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
