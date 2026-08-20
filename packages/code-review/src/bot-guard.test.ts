import { expect, test } from "bun:test";

import { isBotAuthor } from "./bot-guard";

test("a plain human login is not a bot", () => {
  expect(isBotAuthor("octocat")).toBe(false);
});

test.each([
  "dependabot[bot]",
  "renovate[bot]",
  "release-bot",
  "bot-deploy",
  "deploy_bot",
  "bot_deploy",
])("%s reads as a bot login", (login) => {
  expect(isBotAuthor(login)).toBe(true);
});

test("the check is case-insensitive", () => {
  expect(isBotAuthor("Dependabot[BOT]")).toBe(true);
});

test("a login that merely contains the word robot is not flagged", () => {
  expect(isBotAuthor("robotics-team")).toBe(false);
});
