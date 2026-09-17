// CL-6167: load-independent sequential turn drops. A transient
// claim-store failure on a turn's opening `tryClaim` used to propagate out
// of `turnQueue.run` into `routeMessage`'s log-and-swallow — the message
// persisted fine, but no agent was ever asked and no notice ever reached
// the timeline. Sequential, zero concurrency: turn-1 healthy, turn-2 meets
// the failure, and turn-2 must still reach the agent.
import { describe, expect, test } from "bun:test";

import { createChatRoutes } from "../src/routes";
import type { TurnClaimStore } from "@corbits/agent-runtime";
import { createWorkbenchTurnQueue } from "@corbits/agent-runtime";
import { buildDeps, createWorkbench, fakePlatform, mountAs, sendText } from "./test-support";

/** Healthy for the first turn, then a transient failure on every later
 * opening claim — the durable-I/O hiccup the in-memory store never
 * models, arriving on an otherwise idle workbench. */
function failAfterFirstClaim(): TurnClaimStore {
  const holders = new Map<string, string>();
  let n = 0;
  let tryClaimCalls = 0;
  return {
    async tryClaim(c) {
      tryClaimCalls += 1;
      if (tryClaimCalls === 1) {
        const t = String(++n);
        holders.set(c.workbenchId, t);
        return t;
      }
      throw new Error("claim store connection reset");
    },
    async release(c, t) {
      if (holders.get(c.workbenchId) !== t) return false;
      holders.delete(c.workbenchId);
      return true;
    },
    async holds(c, t) {
      return holders.get(c.workbenchId) === t;
    },
  };
}

describe("CL-6167 sequential turn drops", () => {
  test("a transient claim-store failure on turn-2 still asks the agent", async () => {
    const platform = fakePlatform();
    const deps = buildDeps({
      platform,
      turnQueue: createWorkbenchTurnQueue({
        claims: failAfterFirstClaim(),
        publish: () => undefined,
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "demo",
      participants: ["ins_echo1@acme.example"],
    });

    const first = await sendText(app, workbench.id, "hi @ins_echo1");
    expect(first.status).toBe(201);
    const sentMail = platform.sentMail;
    expect(sentMail).toHaveLength(1);

    // Turn-2 meets the transient claim failure. It must still reach the
    // agent — pre-fix this send persisted fine but dispatched nothing.
    const second = await sendText(app, workbench.id, "are you there @ins_echo1");
    expect(second.status).toBe(201);
    expect(sentMail).toHaveLength(2);
    expect(sentMail[1]?.workbenchId).toBe("ins_echo1");
  });
});
