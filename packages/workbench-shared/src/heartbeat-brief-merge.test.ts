import { describe, expect, test } from "bun:test";
import {
  mergeHeartbeatBriefSources,
  parseBriefSourceToolEnvelope,
} from "./heartbeat-brief-merge";

describe("parseBriefSourceToolEnvelope", () => {
  test("parses JSON string content from a successful tool envelope", () => {
    const parsed = parseBriefSourceToolEnvelope({
      callId: "c1",
      isError: false,
      content: JSON.stringify({ notes: [{ id: "n1", title: "Acme" }] }),
    });
    expect(parsed.notes).toEqual([{ id: "n1", title: "Acme" }]);
  });

  test("maps isError envelopes to isError source data", () => {
    const parsed = parseBriefSourceToolEnvelope({
      callId: "c4",
      isError: true,
      content: "403 forbidden",
    });
    expect(parsed).toEqual({ isError: true, error: "403 forbidden" });
  });
});

describe("mergeHeartbeatBriefSources", () => {
  test("keeps every wired source under sources.* when envelopes share callId/content/isError keys", () => {
    const merged = mergeHeartbeatBriefSources({
      "intake-granola": {
        output: {
          callId: "c1",
          isError: false,
          content: JSON.stringify({
            notes: [{ id: "n1", title: "Acme call" }],
          }),
        },
      },
      "intake-linear": {
        output: {
          callId: "c2",
          isError: false,
          content: JSON.stringify({ issues: [{ id: "LIN-1", title: "Ship" }] }),
        },
      },
      "intake-attio": {
        output: {
          callId: "c3",
          isError: false,
          content: JSON.stringify({
            attioActivity: { newCompanies: [], openTasks: [] },
          }),
        },
      },
      "intake-vercel": {
        output: {
          callId: "c4",
          isError: true,
          content: "403 forbidden",
        },
      },
    });

    expect(merged.sources.granola?.notes).toEqual([
      { id: "n1", title: "Acme call" },
    ]);
    expect(merged.sources.linear?.issues).toEqual([
      { id: "LIN-1", title: "Ship" },
    ]);
    expect(merged.sources.attio?.attioActivity).toEqual({
      newCompanies: [],
      openTasks: [],
    });
    expect(merged.sources.vercel).toEqual({
      isError: true,
      error: "403 forbidden",
    });
  });
});
