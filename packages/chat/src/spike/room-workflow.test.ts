import { describe, expect, test } from "bun:test";

import {
  SPIKE_ROOM_SECTION_ID,
  buildSpikeRoomWorkflow,
  spikeTurnChildRunId,
} from "./room-workflow";

const input = {
  roomRunId: "wfr_spike",
  triggerAddress: "wfr_spike@bench.localhost",
  systemPrompt: "Answer briefly.",
  inferencePreferences: [{ provider: "anthropic", model: "claude-sonnet-4-5" }],
  turnTimeoutMs: 60_000,
};

describe("buildSpikeRoomWorkflow", () => {
  test("the room's only step is an onTrigger section bound to the room address", () => {
    const definition = buildSpikeRoomWorkflow(input);

    expect(definition.stepOrder).toEqual([SPIKE_ROOM_SECTION_ID]);
    const section = definition.steps[SPIKE_ROOM_SECTION_ID];
    expect(section?.kind).toBe("onTrigger");
    if (section?.kind !== "onTrigger") throw new Error("not a section");
    expect(section.on).toEqual({ type: "mail", to: input.triggerAddress });
    // A live section is never abandoned mid-conversation at redeploy.
    expect(section.drainBehavior).toBe("wait");
  });

  test("the section body is authored inline as a single agent step", () => {
    const definition = buildSpikeRoomWorkflow(input);
    const section = definition.steps[SPIKE_ROOM_SECTION_ID];
    if (section?.kind !== "onTrigger") throw new Error("not a section");
    if (!("inline" in section.body)) throw new Error("body is not inline");

    const body = section.body.inline;
    expect(body.stepOrder).toEqual(["reply"]);
    const reply = body.steps["reply"];
    expect(reply?.kind).toBe("step");
    if (reply?.kind !== "step") throw new Error("body step is not a step");
    expect(reply.agent.systemPrompt).toBe(input.systemPrompt);
    // The deploy gate approves exactly the sources the agent declares.
    expect(reply.agent.inference.sources).toEqual(input.inferencePreferences);
  });

  test("a turn's child run id names the section and its occurrence", () => {
    expect(spikeTurnChildRunId(0)).toBe("turn__0");
    expect(spikeTurnChildRunId(3)).toBe("turn__3");
  });

  test("an empty trigger address and a non-positive timeout are loud", () => {
    expect(() =>
      buildSpikeRoomWorkflow({ ...input, triggerAddress: "" }),
    ).toThrow(/triggerAddress/);
    expect(() =>
      buildSpikeRoomWorkflow({ ...input, turnTimeoutMs: 0 }),
    ).toThrow(/turnTimeoutMs/);
  });
});
