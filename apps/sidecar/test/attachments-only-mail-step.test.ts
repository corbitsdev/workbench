// CL-6164 pristine repro at the step-invoker seam. An event-only mail
// (`@corbits/chat`'s `workbench.agent-joined`: an empty text/plain part plus
// a JSON attachment) used to reach `agent.send` as `""` and kill the run
// with `retriesExhausted`. Upstream now decodes the mail and omits empty
// content, and the fork threads the run's `MailPartReader` to onTrigger
// bodies, so a body step receives the attachment and no `content`.
import { expect, test } from "bun:test";

import type { Agent, SendResult } from "@intx/agent";
import type { AuthzCallResult } from "@intx/inference";
import type { StepInvokeRequest } from "@intx/workflow";
import {
  createWorkflowStepInvoker,
  type StepEnvBase,
} from "@intx/workflow-host";
import type { InboundMessage, Mail } from "@intx/types/runtime";

const ALLOW: AuthzCallResult = {
  effect: "allow",
  matchingGrants: [],
  resolvedBy: null,
};

const AGENT_JOINED = new TextEncoder().encode(
  JSON.stringify({ type: "workbench.agent-joined", agentId: "agt_1" }),
);

function eventOnlyMail(): Mail {
  return {
    headers: {
      from: "prn_member@bench.example.test",
      to: ["run_anchor@runs.example.test"],
      messageId: "<joined-1@bench.example.test>",
    } as Mail["headers"],
    rawHeaders: {},
    parts: [
      { contentType: "text/plain", ref: "part:text", text: "" },
      {
        contentType: "application/json",
        filename: "workbench.agent-joined.json",
        disposition: "attachment",
        ref: "part:event",
      },
    ],
  };
}

function stubAgent(sent: (string | InboundMessage)[]): Agent {
  const result: SendResult = {
    type: "reply",
    reply: "ok",
    turn: { role: "assistant", content: [] } as never,
  };
  return {
    send: async (content: string | InboundMessage) => {
      sent.push(content);
      return result;
    },
    stream: async function* () {},
    deliver: () => undefined,
    close: async () => undefined,
  } as unknown as Agent;
}

test("an attachments-only mail reaches a body step as attachments with no empty content", async () => {
  const sent: (string | InboundMessage)[] = [];
  const read: string[] = [];
  const invoke = createWorkflowStepInvoker({
    workflowAuthorize: () => Promise.resolve(ALLOW),
    buildEnv: () => Promise.resolve({} as unknown as StepEnvBase),
    agentFactory: () => Promise.resolve(stubAgent(sent)),
    sourcesRef: { current: {} },
    mailPartReader: {
      read: (ref) => {
        read.push(ref);
        return Promise.resolve(AGENT_JOINED);
      },
    },
  });

  const req = {
    agent: { id: "reply", instructions: "reply", tools: [] },
    input: eventOnlyMail(),
    authzContext: { stepId: "reply", runId: "run_1" },
    signal: new AbortController().signal,
  } as unknown as StepInvokeRequest;

  await expect(invoke(req)).resolves.toMatchObject({
    output: { reply: "ok" },
  });
  expect(read).toEqual(["part:event"]);
  const message = sent[0];
  expect(typeof message).toBe("object");
  const inbound = message as InboundMessage;
  expect(inbound.content).toBeUndefined();
  expect(inbound.attachments).toHaveLength(1);
  expect(inbound.attachments?.[0]?.contentType).toBe("application/json");
});

test("without a mail-part reader the same mail is refused loudly, never flattened to an empty string", async () => {
  const sent: (string | InboundMessage)[] = [];
  const invoke = createWorkflowStepInvoker({
    workflowAuthorize: () => Promise.resolve(ALLOW),
    buildEnv: () => Promise.resolve({} as unknown as StepEnvBase),
    agentFactory: () => Promise.resolve(stubAgent(sent)),
    sourcesRef: { current: {} },
  });
  const req = {
    agent: { id: "reply", instructions: "reply", tools: [] },
    input: eventOnlyMail(),
    authzContext: { stepId: "reply", runId: "run_1" },
    signal: new AbortController().signal,
  } as unknown as StepInvokeRequest;

  await expect(invoke(req)).rejects.toThrow(/no mail-part reader wired/);
  expect(sent).toHaveLength(0);
});
