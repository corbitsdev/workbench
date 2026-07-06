import { describe, expect, it } from "bun:test";
import {
  isDefaultMyraThreadLabel,
  myraThreadTitleFromFirstMessage,
} from "./myra-thread";

describe("isDefaultMyraThreadLabel", () => {
  it("matches default chat labels", () => {
    expect(isDefaultMyraThreadLabel("Chat")).toBe(true);
    expect(isDefaultMyraThreadLabel("Chat 2")).toBe(true);
  });

  it("rejects custom labels", () => {
    expect(isDefaultMyraThreadLabel("Q3 pricing")).toBe(false);
    expect(isDefaultMyraThreadLabel("Chat about pricing")).toBe(false);
  });
});

describe("myraThreadTitleFromFirstMessage", () => {
  it("strips trailing punctuation within the char budget", () => {
    expect(myraThreadTitleFromFirstMessage("How are we doing?")).toBe(
      "How are we doing",
    );
  });

  it("truncates long messages on a word boundary", () => {
    const title = myraThreadTitleFromFirstMessage(
      "Can you help me put together a comprehensive pricing strategy for enterprise",
    );
    expect(title).toBe("Can you help me put together a comprehensive");
    expect(title.length).toBeLessThanOrEqual(48);
  });
});
