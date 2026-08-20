import { expect, test } from "bun:test";
import { type } from "arktype";
import { CreateAgentDefinitionInput } from "@corbits/agent-directory";

import { codeReviewAgentRequests } from "./agent-requests";

test("every reviewer installs through the agent create path unchanged", () => {
  const requests = codeReviewAgentRequests();
  expect(requests.length).toBe(3);
  for (const request of requests) {
    const parsed = CreateAgentDefinitionInput(request);
    if (parsed instanceof type.errors) {
      throw new Error(`${request.handle}: ${parsed.summary}`);
    }
  }
});

test("each reviewer gets its own handle", () => {
  const handles = codeReviewAgentRequests().map((request) => request.handle);
  expect(new Set(handles).size).toBe(handles.length);
});
