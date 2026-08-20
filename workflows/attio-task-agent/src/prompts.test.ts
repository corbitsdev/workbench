import { expect, test } from "bun:test";

import {
  ARTIFACT_KIND_GUIDANCE,
  ATTIO_TASK_ARTIFACT_KINDS,
  buildAttioTaskAgentSystemPrompt,
} from "./prompts";

const PROMPT = buildAttioTaskAgentSystemPrompt({
  attioServerSlug: "attio",
  finalizeToolName: "attio_task_agent_finalize",
});

test("every draft kind the prompt offers has its own quality bar", () => {
  for (const kind of ATTIO_TASK_ARTIFACT_KINDS) {
    expect(ARTIFACT_KIND_GUIDANCE[kind].length).toBeGreaterThan(0);
    expect(PROMPT).toContain(`- ${kind}:`);
  }
  expect(Object.keys(ARTIFACT_KIND_GUIDANCE).sort()).toEqual(
    [...ATTIO_TASK_ARTIFACT_KINDS].sort(),
  );
});

test("the dropped Gamma hand-off is gone, not left as a kind nothing can act on", () => {
  expect(ATTIO_TASK_ARTIFACT_KINDS).not.toContain(
    "gamma-presentation" as never,
  );
  expect(PROMPT).not.toContain("gamma");
});

test("grounding is read-only: the prompt routes reads through mcp_read and forbids CRM writes while gathering", () => {
  expect(PROMPT).toContain("mcp_read");
  expect(PROMPT).toContain("Never write to the CRM while you are grounding");
});

test("the CRM write-back is offered, never assumed, and goes through the approval-gated mcp_call", () => {
  expect(PROMPT).toContain("mcp_call");
  expect(PROMPT).toContain("Only if they say yes");
  expect(PROMPT).toContain("nothing was written to the CRM");
});

test("a decline reads as a decision, not an error", () => {
  expect(PROMPT).toContain("Never present a decline as an error");
});

test("the prompt threads in the finalize tool name it is given, so the two cannot drift", () => {
  const renamed = buildAttioTaskAgentSystemPrompt({
    attioServerSlug: "attio",
    finalizeToolName: "some_other_finalize",
  });
  expect(renamed).toContain("some_other_finalize");
  expect(renamed).not.toContain("attio_task_agent_finalize");
});

test("the prompt threads in the CRM server slug it is given", () => {
  const renamed = buildAttioTaskAgentSystemPrompt({
    attioServerSlug: "crm-staging",
    finalizeToolName: "attio_task_agent_finalize",
  });
  expect(renamed).toContain('"crm-staging" server');
});

test("a missing task is a question, never a guess", () => {
  expect(PROMPT).toContain("do not guess");
});

test("the prompt speaks the reader's language, never the system's internals", () => {
  for (const jargon of ["awaitSignal", "ActionInvoker", "toolPackagePins"]) {
    expect(PROMPT).not.toContain(jargon);
  }
});
