import { describe, expect, test } from "bun:test";

import { createBootRestorePushHold } from "./boot-restore-push-hold";

function recordingStore() {
  const held: string[] = [];
  return {
    held,
    markAddressUnroutable(agentAddress: string) {
      held.push(agentAddress);
    },
  };
}

describe("createBootRestorePushHold", () => {
  test("holds every address a boot restore registers", () => {
    const store = recordingStore();
    const hold = createBootRestorePushHold(store);

    hold.begin();
    hold.onDeploymentRegistered("run_a@bench.localhost");
    hold.onDeploymentRegistered("run_b@bench.localhost");
    hold.end();

    expect(store.held).toEqual([
      "run_a@bench.localhost",
      "run_b@bench.localhost",
    ]);
  });

  test("does not hold a deployment that arrives over a live link", () => {
    const store = recordingStore();
    const hold = createBootRestorePushHold(store);

    hold.begin();
    hold.end();
    hold.onDeploymentRegistered("run_c@bench.localhost");

    expect(store.held).toEqual([]);
  });

  test("holds nothing before the restore is armed", () => {
    const store = recordingStore();
    const hold = createBootRestorePushHold(store);

    hold.onDeploymentRegistered("run_d@bench.localhost");

    expect(store.held).toEqual([]);
  });
});
