import { describe, expect, it } from "bun:test";
import { formatHeartbeatBriefDocument } from "./heartbeat-brief-document";

describe("formatHeartbeatBriefDocument", () => {
  it("pairs the title and reply into a title/body document", () => {
    expect(
      formatHeartbeatBriefDocument(
        " Jordan Lee's Morning Brief - 04/07/26 ",
        "# Morning brief\n\nAll clear today.",
      ),
    ).toEqual({
      title: "Jordan Lee's Morning Brief - 04/07/26",
      body: "# Morning brief\n\nAll clear today.",
    });
  });

  it("rejects an empty title or reply", () => {
    expect(() => formatHeartbeatBriefDocument("", "body")).toThrow(/title/);
    expect(() => formatHeartbeatBriefDocument("title", "")).toThrow(/reply/);
  });
});
