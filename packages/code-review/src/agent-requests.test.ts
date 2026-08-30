import { expect, test } from "bun:test";
import { type } from "arktype";
import { CreateAgentDefinitionInput } from "@corbits/agent-directory";

import { codeReviewAgentRequests } from "./agent-requests";
import { CODE_REVIEW_REVIEWERS, reviewerReportPrompt } from "./reviewers";

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

test("an installed reviewer answers a person in prose — the JSON report contract is never in its system prompt", () => {
  for (const request of codeReviewAgentRequests()) {
    expect(request.systemPrompt).not.toContain("Reply with JSON");
    expect(request.systemPrompt).not.toContain('"findings"');
  }
});

test("the report contract rides along only on the path that parses JSON back", () => {
  for (const reviewer of CODE_REVIEW_REVIEWERS) {
    const prompt = reviewerReportPrompt(reviewer);
    expect(prompt).toContain(reviewer.systemPrompt);
    expect(prompt).toContain("Reply with JSON");
  }
});
