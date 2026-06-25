/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import * as transcript from "./index";
import {
  parseSelectedPainPointContext,
  parseStructuredTranscript,
} from "./types";

describe("@workbench/transcript barrel", () => {
  it("re-exports both transcript components", () => {
    expect(typeof transcript.TranscriptPanel).toBe("function");
    expect(typeof transcript.TranscriptReview).toBe("function");
  });

  it("re-exports the arktype schemas and parsers", () => {
    expect(typeof transcript.StructuredTranscript).toBe("function");
    expect(typeof transcript.parseStructuredTranscript).toBe("function");
    expect(typeof transcript.parseSelectedPainPointContext).toBe("function");
  });
});

describe("parseStructuredTranscript", () => {
  const valid = {
    speakers: [{ id: "s1", name: "Ada", role: "rep" }],
    turns: [{ id: "t1", speakerId: "s1", text: "hi", startSeconds: 0 }],
    metadata: { source: "paste", title: "Acme" },
  };

  it("accepts and returns a well-formed transcript", () => {
    const parsed = parseStructuredTranscript(valid);
    expect(parsed.speakers[0]?.role).toBe("rep");
    expect(parsed.turns[0]?.text).toBe("hi");
    expect(parsed.metadata.source).toBe("paste");
  });

  it("accepts a turn without the optional startSeconds", () => {
    const parsed = parseStructuredTranscript({
      ...valid,
      turns: [{ id: "t1", speakerId: "s1", text: "hi" }],
    });
    expect(parsed.turns[0]?.startSeconds).toBeUndefined();
  });

  it("rejects an unknown speaker role", () => {
    expect(() =>
      parseStructuredTranscript({
        ...valid,
        speakers: [{ id: "s1", name: "Ada", role: "boss" }],
      }),
    ).toThrow(/StructuredTranscript/);
  });

  it("rejects an unknown transcript source", () => {
    expect(() =>
      parseStructuredTranscript({
        ...valid,
        metadata: { source: "zoom" },
      }),
    ).toThrow(/StructuredTranscript/);
  });

  it("rejects a turn missing required text", () => {
    expect(() =>
      parseStructuredTranscript({
        ...valid,
        turns: [{ id: "t1", speakerId: "s1" }],
      }),
    ).toThrow(/StructuredTranscript/);
  });
});

describe("parseSelectedPainPointContext", () => {
  it("accepts a well-formed pain point", () => {
    const parsed = parseSelectedPainPointContext({
      id: "p1",
      severity: "high",
      context: "budget",
      quote: "too expensive",
    });
    expect(parsed.severity).toBe("high");
  });

  it("rejects an unknown severity", () => {
    expect(() =>
      parseSelectedPainPointContext({
        id: "p1",
        severity: "blocker",
        context: "budget",
        quote: "too expensive",
      }),
    ).toThrow(/SelectedPainPointContext/);
  });
});
