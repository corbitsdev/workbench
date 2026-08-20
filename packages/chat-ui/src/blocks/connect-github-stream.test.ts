import { expect, test } from "bun:test";

import type { ChatSettingsEventData } from "@corbits/chat/stream-events";

import type { ConnectGithubRepo } from "./connect-github-actions";
import { applyConnectGithubSettingsEvent } from "./connect-github-stream";

const REPOS: readonly ConnectGithubRepo[] = [
  { id: "1", name: "acme/widgets", openPullRequestCount: 0 },
];

test("folds a settled settings event into the connected state", () => {
  const event: ChatSettingsEventData = {
    updatedBy: "prn_owner",
    settings: {
      "template/pendingConnections": [],
      "template/selectedRepos": ["1"],
    },
  };
  expect(
    applyConnectGithubSettingsEvent(event, "github", "octocat", REPOS),
  ).toEqual({
    kind: "connected",
    orgName: "octocat",
    repos: REPOS,
    selectedRepoIds: ["1"],
  });
});

test("folds an event whose connector is still pending into the disconnected state", () => {
  const event: ChatSettingsEventData = {
    updatedBy: "prn_owner",
    settings: { "template/pendingConnections": ["github"] },
  };
  expect(
    applyConnectGithubSettingsEvent(event, "github", "octocat", REPOS),
  ).toEqual({ kind: "disconnected" });
});

test("ignores a settings event carrying no template/* keys at all", () => {
  const event: ChatSettingsEventData = {
    updatedBy: "prn_owner",
    settings: { "chat/theme": "dark" },
  };
  expect(
    applyConnectGithubSettingsEvent(event, "github", "octocat", REPOS),
  ).toBeUndefined();
});
