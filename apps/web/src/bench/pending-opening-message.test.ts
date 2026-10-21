import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import type { WorkbenchParticipant } from "@/chat/threads-api";
import { workbenchKeys } from "../chat-path";
import { parkOpeningMessage, readOpeningMessage } from "../opening-message";
import {
  createPendingOpeningMessageSession,
  dispatchOpeningMessage,
  syncPendingOpeningMessageSession,
} from "./pending-opening-message";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "sessionStorage");
});

describe("opening message tenant isolation", () => {
  test("switching workbenches resets pending session state to the new tenant", () => {
    parkOpeningMessage("tnt_bench_a", "Draft the Q4 launch note");
    const sessionA = {
      ...createPendingOpeningMessageSession("tnt_bench_a"),
      timedOut: true,
    };

    const sessionB = syncPendingOpeningMessageSession(sessionA, "tnt_bench_b");
    expect(sessionB).toEqual({
      workbenchTenantId: "tnt_bench_b",
      text: null,
      timedOut: false,
    });
    expect(readOpeningMessage("tnt_bench_a")).toBe("Draft the Q4 launch note");
  });

  test("in-flight send uses and clears only the originating workbench's opening message", async () => {
    const queryClient = new QueryClient();
    parkOpeningMessage("tnt_bench_a", "Draft the Q4 launch note");

    const calls: Array<{
      readonly workbenchTenantId: string;
      readonly participants: readonly WorkbenchParticipant[];
      readonly content: string;
    }> = [];
    let resolveSend!: () => void;

    const participantsA = [
      { id: "a1", kind: "agent" as const, name: "Worker", address: "run_a@bench-a.localhost" },
    ];
    const pendingSend = dispatchOpeningMessage({
      queryClient,
      workbenchTenantId: "tnt_bench_a",
      participants: participantsA,
      content: "Draft the Q4 launch note",
      send: (args) => {
        calls.push(args);
        return new Promise<void>((resolve) => {
          resolveSend = resolve;
        });
      },
    });

    parkOpeningMessage("tnt_bench_b", "Audit the billing webhook");
    expect(queryClient.getQueryData(workbenchKeys.pendingTurn("tnt_bench_a"))).toBeDefined();
    expect(queryClient.getQueryData(workbenchKeys.pendingTurn("tnt_bench_b"))).toBeUndefined();

    resolveSend();
    await pendingSend;

    expect(calls).toEqual([
      {
        workbenchTenantId: "tnt_bench_a",
        participants: participantsA,
        content: "Draft the Q4 launch note",
      },
    ]);
    expect(readOpeningMessage("tnt_bench_a")).toBeNull();
    expect(readOpeningMessage("tnt_bench_b")).toBe("Audit the billing webhook");
  });
});
