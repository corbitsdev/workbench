import { describe, expect, test } from "bun:test";
import { createGranolaWorkflowTools } from "./workflow-tools";

function tool(name: string) {
  const found = createGranolaWorkflowTools().find(
    (t) => t.definition.name === name,
  );
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

async function run(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const t = tool(name);
  if (t.kind !== "string") throw new Error("expected string tool");
  // AgentTool string handlers take (args, signal).
  return JSON.parse(await t.handler(args, new AbortController().signal));
}

const note = {
  id: "note-1",
  title: "Discovery",
  participants: ["a@corbits.io", "b@acme.com"],
  created_at: "2026-04-01T12:00:00.000Z",
  transcript: [
    { speaker: { source: "microphone" }, text: "hello" },
    { speaker: { source: "speaker" }, text: "world" },
  ],
};

const analysisJson = JSON.stringify({
  summary: "Discussed pricing.",
  painPoints: ["Billing friction"],
  decisions: ["Move to pilot"],
  actionItems: [{ description: "Send quote", assignee: "a@corbits.io" }],
  tasks: [{ description: "Follow up Friday", assignee: "a@corbits.io" }],
  peopleMentioned: ["b@acme.com"],
});

describe("granola workflow pure tools", () => {
  test("normalize_note maps API note into GranolaCall", async () => {
    const result = (await run("granola_normalize_note", {
      note: JSON.stringify(note),
    })) as Record<string, unknown>;
    expect(result.id).toBe("note-1");
    expect(result.transcript).toBe("hello\nworld");
    expect(result.participants).toEqual(["a@corbits.io", "b@acme.com"]);
  });

  test("classify_call marks mixed attendees external", async () => {
    const result = (await run("granola_classify_call", {
      participants: note.participants,
      tenantDomain: "corbits.io",
    })) as { classification: string };
    expect(result.classification).toBe("external");
  });

  test("classify_call returns unknown when tenantDomain is missing", async () => {
    const result = (await run("granola_classify_call", {
      participants: note.participants,
    })) as { classification: string };
    expect(result.classification).toBe("unknown");
  });

  test("build_analysis_prompt returns text for the agent step", async () => {
    const normalized = await run("granola_normalize_note", { note });
    const result = (await run("granola_build_analysis_prompt", {
      note: normalized,
    })) as { text: string };
    expect(typeof result.text).toBe("string");
    expect(result.text.length).toBeGreaterThan(20);
    expect(result.text).toContain("Discovery");
  });

  test("parse_analysis strips fences and validates", async () => {
    const result = (await run("granola_parse_analysis", {
      text: "```json\n" + analysisJson + "\n```",
    })) as { summary: string };
    expect(result.summary).toBe("Discussed pricing.");
  });

  test("prepare_artifacts emits flat write_artifact fields", async () => {
    const normalized = await run("granola_normalize_note", { note });
    const analysis = await run("granola_parse_analysis", {
      text: analysisJson,
    });
    const result = (await run("granola_prepare_artifacts", {
      note: normalized,
      analysis,
      classification: "external",
    })) as Record<string, unknown>;
    expect(result.painKind).toBe("granola-call-pain-points");
    expect(result.summaryKind).toBe("granola-call-summary");
    expect(result.briefKind).toBe("granola-call-brief");
    expect(String(result.painSourceRef)).toContain("granola:call:note-1:");
    expect(String(result.painContent)).toContain("Billing friction");
  });

  test("emit_run_outputs builds artifactsByKind", async () => {
    const result = (await run("granola_emit_run_outputs", {
      noteId: "note-1",
      classification: "external",
      painArtifactId: "art-p",
      summaryArtifactId: "art-s",
      briefArtifactId: "art-b",
    })) as {
      noteId: string;
      classification: string;
      artifactsByKind: Record<string, string>;
    };
    expect(result).toEqual({
      noteId: "note-1",
      classification: "external",
      artifactsByKind: {
        "granola-call-pain-points": "art-p",
        "granola-call-summary": "art-s",
        "granola-call-brief": "art-b",
      },
    });
  });

  test("emit_run_outputs peels projected step envelopes", async () => {
    const result = (await run("granola_emit_run_outputs", {
      prepare: {
        content: JSON.stringify({
          noteId: "note-9",
          classification: "internal",
        }),
      },
      "persist-pain": {
        content: JSON.stringify({ artifactId: "pain-9" }),
      },
      "persist-summary": {
        content: JSON.stringify({ artifactId: "sum-9" }),
      },
      "persist-brief": {
        content: JSON.stringify({ artifactId: "brief-9" }),
      },
    })) as {
      noteId: string;
      classification: string;
      artifactsByKind: Record<string, string>;
    };
    expect(result.noteId).toBe("note-9");
    expect(result.classification).toBe("internal");
    expect(result.artifactsByKind).toEqual({
      "granola-call-pain-points": "pain-9",
      "granola-call-summary": "sum-9",
      "granola-call-brief": "brief-9",
    });
  });
});
