import { describe, expect, test } from "bun:test";
import { deliverWhenRoutable } from "./deliver-when-routable";

function unreachable(): Error {
  return new Error("agent is unreachable: run_1@ten1.workbench.test");
}

describe("deliverWhenRoutable", () => {
  test("retries once the address is routable after an unreachable send", async () => {
    let sendCalls = 0;
    let routablePolls = 0;
    const sleeps: number[] = [];

    const result = await deliverWhenRoutable({
      send: async () => {
        sendCalls++;
        if (sendCalls === 1) {
          throw unreachable();
        }
        return "delivered";
      },
      isRoutable: () => {
        routablePolls++;
        return routablePolls >= 2;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(result).toBe("delivered");
    expect(sendCalls).toBe(2);
    expect(routablePolls).toBe(2);
    expect(sleeps.length).toBe(1);
  });

  test("rethrows the original unreachable error once the deadline passes", async () => {
    let now = 0;
    const originalNow = Date.now;
    Date.now = () => now;
    try {
      let sendCalls = 0;
      await expect(
        deliverWhenRoutable({
          send: async () => {
            sendCalls++;
            throw unreachable();
          },
          isRoutable: () => false,
          deadlineMs: 500,
          pollIntervalMs: 100,
          sleep: async (ms) => {
            now += ms;
          },
        }),
      ).rejects.toThrow("agent is unreachable");
      expect(sendCalls).toBe(1);
    } finally {
      Date.now = originalNow;
    }
  });

  test("does not retry an error other than unreachable", async () => {
    const err = new Error("boom");
    await expect(
      deliverWhenRoutable({
        send: async () => {
          throw err;
        },
        isRoutable: () => true,
      }),
    ).rejects.toBe(err);
  });
});
