import { describe, it, expect } from "bun:test";
import { IntakeRequest, IntakeResponse } from "./intake";

describe("Intake types", () => {
  it("exports IntakeRequest type", () => {
    const req: IntakeRequest = {
      transcript: "Speaker: Hello",
      source: "paste",
    };
    expect(req.source).toBe("paste");
  });

  it("exports IntakeResponse type", () => {
    const res: IntakeResponse = {
      sessionId: "123",
      transcriptId: "456",
      status: "analyzing",
    };
    expect(res).toHaveProperty("sessionId");
  });
});
