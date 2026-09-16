// CL-7201: `dispatchTurn` must refuse to start a mail send at all
// for a turn whose signal was ALREADY aborted before the call — as
// opposed to CL-7230's disclosed ceiling (a signal that aborts WHILE
// `sendMail` is already in flight, which genuinely cannot be stopped).
// An already-aborted signal at entry means the caller knew, before ever
// asking this to do anything, that the turn was cancelled; dispatching
// a brand-new mail send at that point orphans a reply nothing will ever
// attach to a running row again.
import { describe, expect, test } from "bun:test";

import { createInMemoryAgentTurnStore } from "../src/agent-turns";
import { ChatMessageEventData } from "../src/stream-events";
import { TurnCancelledError } from "../src/turn-cancellation";
import { dispatchTurn } from "../src/workbench-service";
import { buildDeps, fakePlatform, TENANT } from "./test-support";

describe("dispatchTurn with an already-aborted signal (CL-7201)", () => {
  test("never calls sendMail, and settles the row cancelled", async () => {
    const platform = fakePlatform();
    const agentTurns = createInMemoryAgentTurnStore();
    const deps = buildDeps({ platform, agentTurns });
    const events: { type: string; data: unknown }[] = [];
    const controller = new AbortController();
    controller.abort(new TurnCancelledError());

    await dispatchTurn(
      {
        platform: deps.platform,
        agentTurns,
        store: deps.store,
        mailbox: deps.mailbox,
        parts: deps.parts,
        publish: (
          _workbenchId: string,
          event: { type: string; data: unknown },
        ) => {
          events.push(event);
        },
      },
      {
        tenantId: TENANT.id,
        workbenchId: "wb_1",
        principalId: "prn_1",
        agentAddress: "ins_echo1@acme.example",
        parts: [{ kind: "text", text: "hello" }],
        requestMessageIds: ["msg_1"],
      },
      controller.signal,
    );
    // The abort-close runs on a fire-and-forget `.then` off `finishTurn`,
    // so flush before asserting on the notice it posts.
    await Bun.sleep(5);

    expect(platform.sentMail).toHaveLength(0);

    const turns = await agentTurns.listTurns({
      tenantId: TENANT.id,
      workbenchId: "wb_1",
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]?.status).toBe("cancelled");

    // The cancelled notice goes out mailbox-first (fanout + parts sidecar)
    // like every other timeline write now, so it surfaces as a published
    // `chat.message` rather than a sidecar row.
    const notices = events
      .filter((event) => event.type === "chat.message")
      .map((event) => ChatMessageEventData.assert(event.data))
      .filter((data) =>
        data.parts.some(
          (part) => part.kind === "text" && part.turnCancelled === true,
        ),
      );
    expect(notices).toHaveLength(1);
  });
});
