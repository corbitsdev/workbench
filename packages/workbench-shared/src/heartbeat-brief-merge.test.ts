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

  test("maps isError envelopes to isError source data (legacy nonFatal deterministicToolStep shape)", () => {
    const parsed = parseBriefSourceToolEnvelope({
      callId: "c4",
      isError: true,
      content: "403 forbidden",
    });
    expect(parsed).toEqual({ isError: true, error: "403 forbidden" });
  });

  // `heartbeat_intake_source` (the native-action intake wrapper)
  // never sets the outer `isError` — `ActionPrimitive` has no `nonFatal`
  // escape, so a source failure is carried inside `content` as
  // `{ isError: true, error }` instead of a thrown/outer-isError tool result.
  // This is the shape every real heartbeat intake step now produces.
  test("maps a degraded (outer isError: false) envelope's nested isError content to isError source data", () => {
    const parsed = parseBriefSourceToolEnvelope({
      callId: "c4",
      isError: false,
      content: {
        isError: true,
        error: "source unavailable: no vercel credential configured",
      },
    });
    expect(parsed).toEqual({
      isError: true,
      error: "source unavailable: no vercel credential configured",
    });
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

  // Proves the real `heartbeat_intake_source` output contract
  // (outer isError always false, failure nested in content) still degrades
  // that one source to a "not available" note, keeping every other source
  // intact, rather than silently treating the failure as an empty success.
  test("degrades one source to isError data when its intake action's content carries a nested isError, other sources unaffected", () => {
    const merged = mergeHeartbeatBriefSources({
      "intake-granola": {
        output: {
          callId: "c1",
          isError: false,
          content: JSON.stringify({ notes: [] }),
        },
      },
      "intake-linear": {
        output: {
          callId: "c2",
          isError: false,
          content: JSON.stringify({ issues: [] }),
        },
      },
      "intake-attio": {
        output: {
          callId: "c3",
          isError: false,
          content: {
            isError: true,
            error: "source unavailable: no attio credential configured",
          },
        },
      },
      "intake-vercel": {
        output: {
          callId: "c4",
          isError: false,
          content: JSON.stringify({ deployments: [] }),
        },
      },
    });

    expect(merged.sources.attio).toEqual({
      isError: true,
      error: "source unavailable: no attio credential configured",
    });
    expect(merged.sources.granola).toEqual({ notes: [] });
    expect(merged.sources.linear).toEqual({ issues: [] });
    expect(merged.sources.vercel).toEqual({ deployments: [] });
  });
});
