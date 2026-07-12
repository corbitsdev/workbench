import { describe, expect, it } from "bun:test";
import type {
  ToolCall,
  ToolDefinition,
  ToolResult,
  ToolRunner,
} from "@intx/types/runtime";
import {
  createGuardedMailRunner,
  CORRESPONDENT_WINDOW_MS,
  MAX_IDENTICAL_OUTBOUND,
  MAX_OUTBOUND_PER_CORRESPONDENT,
  MAX_OUTBOUND_PER_TURN,
  MAX_TRACKED_CORRESPONDENTS,
} from "./mail-guard";

type DefinedRunner = ToolRunner & { definitions: ToolDefinition[] };

function def(name: string): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {}, required: [] },
  };
}

function countingRunner(): DefinedRunner & { calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  return {
    calls,
    definitions: [def("mail_send"), def("mail_reply"), def("mail_search")],
    run(call: ToolCall): Promise<ToolResult> {
      calls.push(call);
      return Promise.resolve({ callId: call.id, content: { ok: true } });
    },
  };
}

function send(id: string, content: string): ToolCall {
  return {
    id,
    name: "mail_send",
    arguments: { to: "ins_x@gtm.localhost", content },
  };
}

describe("createGuardedMailRunner", () => {
  it("suppresses identical outbound mail after the first send", async () => {
    const inner = countingRunner();
    const guarded = createGuardedMailRunner(inner);
    const signal = new AbortController().signal;

    const results: ToolResult[] = [];
    for (let i = 0; i < 15; i++) {
      results.push(
        await guarded.run(send(`c${i}`, "the browser timed out"), signal),
      );
    }

    // Only the first identical body reaches the real runner.
    expect(inner.calls).toHaveLength(MAX_IDENTICAL_OUTBOUND);
    const blocked = results.filter((r) => r.isError);
    expect(blocked).toHaveLength(15 - MAX_IDENTICAL_OUTBOUND);
    expect(JSON.stringify(blocked[0]?.content)).toContain("Duplicate");
  });

  it("allows the same body sent to different recipients (fan-out)", async () => {
    const inner = countingRunner();
    const guarded = createGuardedMailRunner(inner);
    const signal = new AbortController().signal;

    const recipients = [
      "ins_a@gtm.localhost",
      "ins_b@gtm.localhost",
      "ins_c@gtm.localhost",
    ];
    for (const [i, to] of recipients.entries()) {
      await guarded.run(
        {
          id: `c${i}`,
          name: "mail_send",
          arguments: { to, content: "same announcement" },
        },
        signal,
      );
    }

    expect(inner.calls).toHaveLength(3);
  });

  it("caps total distinct outbound mail per turn", async () => {
    const inner = countingRunner();
    const guarded = createGuardedMailRunner(inner);
    const signal = new AbortController().signal;

    const results: ToolResult[] = [];
    for (let i = 0; i < MAX_OUTBOUND_PER_TURN + 3; i++) {
      results.push(
        await guarded.run(send(`c${i}`, `distinct body ${i}`), signal),
      );
    }

    expect(inner.calls).toHaveLength(MAX_OUTBOUND_PER_TURN);
    expect(results.filter((r) => r.isError)).toHaveLength(3);
    const lastBlocked = results[results.length - 1];
    expect(JSON.stringify(lastBlocked?.content)).toContain("cap");
  });

  it("uses a custom outbound cap when provided", async () => {
    const inner = countingRunner();
    const guarded = createGuardedMailRunner(inner, { maxOutboundPerTurn: 3 });
    const signal = new AbortController().signal;

    const results: ToolResult[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(
        await guarded.run(send(`c${i}`, `distinct body ${i}`), signal),
      );
    }

    expect(inner.calls).toHaveLength(3);
    expect(results.filter((r) => r.isError)).toHaveLength(2);
    expect(JSON.stringify(results.at(-1)?.content)).toContain("3 this turn");
  });

  it("resets the outbound budget for the next turn", async () => {
    const inner = countingRunner();
    const guarded = createGuardedMailRunner(inner);
    const signal = new AbortController().signal;

    for (let i = 0; i < MAX_OUTBOUND_PER_TURN; i++) {
      await guarded.run(send(`c${i}`, `turn one body ${i}`), signal);
    }

    const blocked = await guarded.run(send("blocked", "over budget"), signal);
    expect(blocked.isError).toBe(true);

    guarded.resetOutboundBudget();

    const allowed = await guarded.run(
      send("next-turn", "next turn body"),
      signal,
    );
    expect(allowed.isError).toBeUndefined();
    expect(inner.calls).toHaveLength(MAX_OUTBOUND_PER_TURN + 1);
  });

  it("resets duplicate suppression for the next turn", async () => {
    const inner = countingRunner();
    const guarded = createGuardedMailRunner(inner);
    const signal = new AbortController().signal;

    await guarded.run(send("first", "same follow-up"), signal);
    const duplicate = await guarded.run(
      send("duplicate", "same follow-up"),
      signal,
    );
    expect(duplicate.isError).toBe(true);

    guarded.resetOutboundBudget();

    const allowed = await guarded.run(
      send("next-turn", "same follow-up"),
      signal,
    );
    expect(allowed.isError).toBeUndefined();
    expect(inner.calls).toHaveLength(2);
  });

  it("passes through non-mail-write tools untouched", async () => {
    const inner = countingRunner();
    const guarded = createGuardedMailRunner(inner);
    const signal = new AbortController().signal;

    const searchCall: ToolCall = {
      id: "s1",
      name: "mail_search",
      arguments: { query: {} },
    };
    for (let i = 0; i < 20; i++) await guarded.run(searchCall, signal);

    expect(inner.calls).toHaveLength(20);
  });

  it("does not count a failed send against the budget", async () => {
    const calls: ToolCall[] = [];
    const failing: DefinedRunner = {
      definitions: [def("mail_send")],
      run(call: ToolCall): Promise<ToolResult> {
        calls.push(call);
        return Promise.resolve({
          callId: call.id,
          content: { error: "boom" },
          isError: true,
        });
      },
    };
    const guarded = createGuardedMailRunner(failing);
    const signal = new AbortController().signal;

    // Distinct bodies that all fail downstream should keep reaching the runner;
    // a failed send neither consumed the budget nor counts as "already sent".
    for (let i = 0; i < MAX_OUTBOUND_PER_TURN + 2; i++) {
      await guarded.run(send(`c${i}`, `body ${i}`), signal);
    }
    expect(calls).toHaveLength(MAX_OUTBOUND_PER_TURN + 2);
  });

  function sendTo(id: string, to: string, content: string): ToolCall {
    return { id, name: "mail_send", arguments: { to, content } };
  }

  it("terminates a two-agent ping-pong despite the budget resetting on every inbound turn", async () => {
    const inner = countingRunner();
    const guarded = createGuardedMailRunner(inner);
    const signal = new AbortController().signal;
    const other = "ins_other@gtm.localhost";

    const results: ToolResult[] = [];
    for (let turn = 0; turn < MAX_OUTBOUND_PER_CORRESPONDENT + 3; turn++) {
      // Each turn simulates: an inbound message from the other agent arrives
      // (resetting the per-turn budget), then this agent replies.
      guarded.resetOutboundBudget();
      results.push(
        await guarded.run(sendTo(`turn${turn}`, other, `reply ${turn}`), signal),
      );
    }

    expect(inner.calls).toHaveLength(MAX_OUTBOUND_PER_CORRESPONDENT);
    const blocked = results.filter((r) => r.isError);
    expect(blocked).toHaveLength(3);
    expect(JSON.stringify(blocked[0]?.content)).toContain(
      "Too many messages",
    );
  });

  it("never throttles sends to a member (usr_) recipient across many turns", async () => {
    const inner = countingRunner();
    const guarded = createGuardedMailRunner(inner);
    const signal = new AbortController().signal;
    const member = "usr_sawyer@gtm.localhost";

    const turns = MAX_OUTBOUND_PER_CORRESPONDENT + 10;
    for (let turn = 0; turn < turns; turn++) {
      guarded.resetOutboundBudget();
      const result = await guarded.run(
        sendTo(`m${turn}`, member, `message ${turn}`),
        signal,
      );
      expect(result.isError).toBeUndefined();
    }

    expect(inner.calls).toHaveLength(turns);
  });

  it("allows resumption once the correspondent window expires", async () => {
    const inner = countingRunner();
    let clock = 0;
    const guarded = createGuardedMailRunner(inner, { now: () => clock });
    const signal = new AbortController().signal;
    const other = "ins_other@gtm.localhost";

    for (let i = 0; i < MAX_OUTBOUND_PER_CORRESPONDENT; i++) {
      guarded.resetOutboundBudget();
      const result = await guarded.run(
        sendTo(`w${i}`, other, `body ${i}`),
        signal,
      );
      expect(result.isError).toBeUndefined();
    }

    guarded.resetOutboundBudget();
    const blocked = await guarded.run(
      sendTo("blocked", other, "over correspondent cap"),
      signal,
    );
    expect(blocked.isError).toBe(true);

    clock += CORRESPONDENT_WINDOW_MS + 1;
    guarded.resetOutboundBudget();
    const resumed = await guarded.run(
      sendTo("resumed", other, "after window expiry"),
      signal,
    );
    expect(resumed.isError).toBeUndefined();
    expect(inner.calls).toHaveLength(MAX_OUTBOUND_PER_CORRESPONDENT + 1);
  });

  it("prunes least-recently-touched correspondents once the tracked cap is hit", async () => {
    const inner = countingRunner();
    const guarded = createGuardedMailRunner(inner);
    const signal = new AbortController().signal;
    const first = "ins_first@gtm.localhost";

    for (let i = 0; i < MAX_OUTBOUND_PER_CORRESPONDENT; i++) {
      guarded.resetOutboundBudget();
      await guarded.run(sendTo(`f${i}`, first, `body ${i}`), signal);
    }
    guarded.resetOutboundBudget();
    const blocked = await guarded.run(
      sendTo("blocked", first, "over cap"),
      signal,
    );
    expect(blocked.isError).toBe(true);

    for (let i = 0; i < MAX_TRACKED_CORRESPONDENTS; i++) {
      guarded.resetOutboundBudget();
      await guarded.run(
        sendTo(`o${i}`, `ins_other${i}@gtm.localhost`, "hello"),
        signal,
      );
    }

    guarded.resetOutboundBudget();
    const afterEviction = await guarded.run(
      sendTo("after-eviction", first, "history should be forgotten"),
      signal,
    );
    expect(afterEviction.isError).toBeUndefined();
  });
});
