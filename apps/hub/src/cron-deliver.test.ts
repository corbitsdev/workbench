// The bug this covers: a due schedule used to be handed to the mailbox
// persist path, whose sender authorization has no live endpoint for
// `cron@<domain>` and drops the delivery. Cron must take the run-trigger
// route instead, with the run as the authenticated sender.
import { describe, expect, test } from "bun:test";

import { createCronDeliver } from "./cron-deliver";

const RUN_ADDRESS = "run_abc123@alice.localhost";

function routerSpy() {
  const routed: { address: string; authenticatedSender: string }[] = [];
  const granted: string[] = [];
  return {
    routed,
    granted,
    router: {
      routeMail: (address: string, _raw: string, authenticatedSender: string) => {
        routed.push({ address, authenticatedSender });
        return true;
      },
      sendRunGrants: (address: string) => {
        granted.push(address);
        return true;
      },
    },
  };
}

describe("createCronDeliver", () => {
  test("routes a due schedule as the run's own authenticated sender", async () => {
    const spy = routerSpy();
    const deliver = createCronDeliver({
      router: spy.router,
      materialize: async () => ({ outcome: "materialized", stepGrants: [] }),
      tenantDomain: async () => "alice.localhost",
    });

    await deliver({
      to: [RUN_ADDRESS],
      subject: "standup",
      body: "time to check in",
      tenantId: "tenant-1",
    });

    expect(spy.granted).toEqual([RUN_ADDRESS]);
    expect(spy.routed).toEqual([{ address: RUN_ADDRESS, authenticatedSender: RUN_ADDRESS }]);
  });

  test("refuses an address that is not a live run", async () => {
    const spy = routerSpy();
    const deliver = createCronDeliver({
      router: spy.router,
      materialize: async () => ({ outcome: "materialized", stepGrants: [] }),
      tenantDomain: async () => "alice.localhost",
    });

    await expect(
      deliver({
        to: ["alice@alice.localhost"],
        subject: "s",
        body: "b",
        tenantId: "tenant-1",
      }),
    ).rejects.toThrow("not a live run address");
    expect(spy.routed).toEqual([]);
  });

  test("refuses when the deployment has no materialized grants", async () => {
    const spy = routerSpy();
    const deliver = createCronDeliver({
      router: spy.router,
      materialize: async () => ({ outcome: "rejected", message: "run is terminal" }),
      tenantDomain: async () => "alice.localhost",
    });

    await expect(
      deliver({ to: [RUN_ADDRESS], subject: "s", body: "b", tenantId: "tenant-1" }),
    ).rejects.toThrow("run is terminal");
    expect(spy.routed).toEqual([]);
  });
});
