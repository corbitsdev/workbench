import { expect, test } from "bun:test";

import { CREATE_AGENT_TOOL as REAL_CREATE_AGENT_TOOL } from "@corbits/agent-directory-tools";
import { LIST_CONNECTIONS_TOOL as REAL_LIST_CONNECTIONS_TOOL } from "@corbits/connections-tools";
import {
  GITHUB_PULL_REQUEST_DIFF_TOOL as REAL_GITHUB_PULL_REQUEST_DIFF_TOOL,
  GITHUB_POST_PULL_REQUEST_REVIEW_TOOL as REAL_GITHUB_POST_PR_REVIEW_TOOL,
} from "@corbits/github-tools";

import {
  CREATE_AGENT_TOOL,
  MEMORY_ADD_TOOL,
  LIST_CONNECTIONS_TOOL,
  GITHUB_PULL_REQUEST_DIFF_TOOL,
  GITHUB_POST_PR_REVIEW_TOOL,
  BUILD_TOOLS,
} from "./tool-names.ts";

test("eval tool-name constants match the real manager-tools bundles", () => {
  expect(CREATE_AGENT_TOOL).toBe(REAL_CREATE_AGENT_TOOL);
  // `@corbits/memory` exports no name constant — its
  // `memoryAdd` tool factory names itself "memory_add" inline.
  expect(MEMORY_ADD_TOOL).toBe("memory_add");
  expect(LIST_CONNECTIONS_TOOL).toBe(REAL_LIST_CONNECTIONS_TOOL);
});

test("GitHub tool-name constants match the real @corbits/github-tools bundle", () => {
  expect(GITHUB_PULL_REQUEST_DIFF_TOOL).toBe(REAL_GITHUB_PULL_REQUEST_DIFF_TOOL);
  expect(GITHUB_POST_PR_REVIEW_TOOL).toBe(REAL_GITHUB_POST_PR_REVIEW_TOOL);
});

test("BUILD_TOOLS names the state-changing manager tools", () => {
  expect(BUILD_TOOLS).toEqual([CREATE_AGENT_TOOL]);
});
