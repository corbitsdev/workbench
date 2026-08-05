import { expect, test } from "bun:test";
import { createHubLinkWatchdog } from "../src/hub-link-watchdog";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("fires onStall when an armed deadline expires without progress", async () => {
  let stalled = 0;
  const watchdog = createHubLinkWatchdog({
    stallDeadlineMs: 20,
    onStall: () => {
      stalled += 1;
    },
  });
  watchdog.armForBoot();
  await sleep(40);
  expect(stalled).toBe(1);
});

test("markAlive disarms the deadline", async () => {
  let stalled = 0;
  const watchdog = createHubLinkWatchdog({
    stallDeadlineMs: 20,
    onStall: () => {
      stalled += 1;
    },
  });
  watchdog.armForBoot();
  watchdog.markAlive();
  await sleep(40);
  expect(stalled).toBe(0);
});

test("a scheduled reconnect re-arms the deadline before running", async () => {
  let stalled = 0;
  let ran = 0;
  const watchdog = createHubLinkWatchdog({
    stallDeadlineMs: 20,
    onStall: () => {
      stalled += 1;
    },
  });
  watchdog.scheduleReconnect(() => {
    ran += 1;
  }, 5);
  await sleep(50);
  expect(ran).toBe(1);
  expect(stalled).toBe(1);
});

test("a cancelled reconnect never runs and never arms", async () => {
  let stalled = 0;
  let ran = 0;
  const watchdog = createHubLinkWatchdog({
    stallDeadlineMs: 20,
    onStall: () => {
      stalled += 1;
    },
  });
  const cancel = watchdog.scheduleReconnect(() => {
    ran += 1;
  }, 5);
  cancel();
  await sleep(50);
  expect(ran).toBe(0);
  expect(stalled).toBe(0);
});
