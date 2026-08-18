import { describe, expect, test } from "bun:test";
import {
  wireMailRedelivery,
  type MailRedeliveryChatPlatform,
  type MailRedeliverySidecarRouter,
} from "../src/mail-redelivery";

function createFakeSidecarRouter(opts: {
  routableAddresses?: string[];
  routeMailResult?: boolean;
}): MailRedeliverySidecarRouter & {
  emit(event: { rawMessage: string; recipients: string[] }): void;
  routeMailCalls: { agentAddress: string; rawMessage: string }[];
} {
  const listeners = new Set<
    (event: { rawMessage: string; recipients: string[] }) => void
  >();
  const routeMailCalls: { agentAddress: string; rawMessage: string }[] = [];
  return {
    routeMailCalls,
    events: {
      on(_type, listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    getRoutableAddresses: () => opts.routableAddresses ?? [],
    routeMail: (agentAddress, rawMessage) => {
      routeMailCalls.push({ agentAddress, rawMessage });
      return opts.routeMailResult ?? true;
    },
    emit(event) {
      for (const listener of listeners) listener(event);
    },
  };
}

function createFakeChatPlatform(opts: {
  ensureAwakeShouldReject?: boolean;
}): MailRedeliveryChatPlatform & { ensureAwakeCalls: string[] } {
  const ensureAwakeCalls: string[] = [];
  return {
    ensureAwakeCalls,
    async ensureAwake(address) {
      ensureAwakeCalls.push(address);
      if (opts.ensureAwakeShouldReject) {
        throw new Error("not a chat resident");
      }
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("wireMailRedelivery", () => {
  test("does nothing extra for an already-routable recipient, but still retries delivery", async () => {
    const sidecarRouter = createFakeSidecarRouter({
      routableAddresses: ["ins_1@ten1.test"],
    });
    const chatPlatform = createFakeChatPlatform({});
    wireMailRedelivery({ sidecarRouter, chatPlatform });

    sidecarRouter.emit({
      rawMessage: "raw-mail-bytes",
      recipients: ["ins_1@ten1.test"],
    });
    await flush();

    expect(chatPlatform.ensureAwakeCalls).toEqual([]);
    expect(sidecarRouter.routeMailCalls).toEqual([
      { agentAddress: "ins_1@ten1.test", rawMessage: "raw-mail-bytes" },
    ]);
  });

  test("wakes a non-routable recipient before retrying delivery", async () => {
    const sidecarRouter = createFakeSidecarRouter({ routableAddresses: [] });
    const chatPlatform = createFakeChatPlatform({});
    wireMailRedelivery({ sidecarRouter, chatPlatform });

    sidecarRouter.emit({
      rawMessage: "raw-mail-bytes",
      recipients: ["ins_2@ten1.test"],
    });
    await flush();

    expect(chatPlatform.ensureAwakeCalls).toEqual(["ins_2@ten1.test"]);
    expect(sidecarRouter.routeMailCalls).toEqual([
      { agentAddress: "ins_2@ten1.test", rawMessage: "raw-mail-bytes" },
    ]);
  });

  test("still retries delivery when the recipient is not a chat resident ensureAwake can wake", async () => {
    const sidecarRouter = createFakeSidecarRouter({ routableAddresses: [] });
    const chatPlatform = createFakeChatPlatform({
      ensureAwakeShouldReject: true,
    });
    wireMailRedelivery({ sidecarRouter, chatPlatform });

    sidecarRouter.emit({
      rawMessage: "raw-mail-bytes",
      recipients: ["run_task_1@ten1.test"],
    });
    await flush();

    expect(chatPlatform.ensureAwakeCalls).toEqual(["run_task_1@ten1.test"]);
    expect(sidecarRouter.routeMailCalls).toEqual([
      { agentAddress: "run_task_1@ten1.test", rawMessage: "raw-mail-bytes" },
    ]);
  });

  test("handles multiple recipients on the same event independently", async () => {
    const sidecarRouter = createFakeSidecarRouter({
      routableAddresses: ["ins_routable@ten1.test"],
    });
    const chatPlatform = createFakeChatPlatform({});
    wireMailRedelivery({ sidecarRouter, chatPlatform });

    sidecarRouter.emit({
      rawMessage: "raw-mail-bytes",
      recipients: ["ins_routable@ten1.test", "ins_asleep@ten1.test"],
    });
    await flush();

    expect(chatPlatform.ensureAwakeCalls).toEqual(["ins_asleep@ten1.test"]);
    expect(
      sidecarRouter.routeMailCalls.map((c) => c.agentAddress).sort(),
    ).toEqual(["ins_asleep@ten1.test", "ins_routable@ten1.test"]);
  });
});
