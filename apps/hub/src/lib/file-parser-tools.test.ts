/// <reference types="bun" />
import { describe, expect, it, mock, beforeEach } from "bun:test";

type Row = Record<string, unknown>;

// Captures the args parse_file forwards to the in-hub parse turn so we can assert
// the tool decoded the artifact's data URL and resolved the caller's instance.
let parseCalls: unknown[] = [];
let parseResult = "PARSED DOCUMENT TEXT";

mock.module("../services/file-parser", () => ({
  parseDocument: (_db: unknown, input: unknown) => {
    parseCalls.push(input);
    return Promise.resolve(parseResult);
  },
  FileParseError: class FileParseError extends Error {},
}));

const { FILEPARSER_HUB_TOOLS } = await import("./file-parser-tools");

function selectChain(queue: Row[][]) {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = () => Promise.resolve(queue.shift() ?? []);
  return chain;
}

function makeDb(selectQueue: Row[][]) {
  const queue = [...selectQueue];
  return { select: () => selectChain(queue) };
}

type StringHandler = (
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<string>;

function handler(context: {
  db: unknown;
  tenantId: string;
  principalId: string;
  agentId: string;
  sessionId: string;
}): StringHandler {
  const entry = FILEPARSER_HUB_TOOLS.parse_file!;
  const [tool] = entry.createTools(context as never);
  if (!tool || tool.kind !== "string") {
    throw new Error("parse_file must be a string-kind tool");
  }
  return tool.handler;
}

const BASE = {
  tenantId: "tnt_1",
  principalId: "prn_instance_1",
  agentId: "agt_1",
  sessionId: "ses_1",
};

// "SGVsbG8gUERG" is base64 for "Hello PDF".
const PDF_DATA_URL = "data:application/pdf;base64,SGVsbG8gUERG";

describe("parse_file hub tool (CL-2628)", () => {
  beforeEach(() => {
    parseCalls = [];
    parseResult = "PARSED DOCUMENT TEXT";
  });

  it("decodes the artifact data URL and returns parsed text keyed to the artifact", async () => {
    const db = makeDb([
      [{ id: "art_1", title: "report.pdf", content: PDF_DATA_URL }],
    ]);
    const run = handler({ ...BASE, db });

    const out = await run(
      { artifactId: "art_1", instructions: "summarize" },
      new AbortController().signal,
    );

    expect(out).toBe("PARSED DOCUMENT TEXT");
    expect(parseCalls).toHaveLength(1);
    const call = parseCalls[0] as {
      tenantId: string;
      traceId: string;
      filename: string;
      mimeType: string;
      bytes: Uint8Array;
      instructions?: string;
    };
    expect(call.tenantId).toBe("tnt_1");
    expect(call.traceId).toBe("art_1");
    expect(call.filename).toBe("report.pdf");
    expect(call.mimeType).toBe("application/pdf");
    expect(call.instructions).toBe("summarize");
    expect(Buffer.from(call.bytes).toString("utf8")).toBe("Hello PDF");
  });

  it("throws when the artifact does not exist", async () => {
    const db = makeDb([[]]);
    const run = handler({ ...BASE, db });
    await expect(
      run({ artifactId: "missing" }, new AbortController().signal),
    ).rejects.toThrow("Artifact not found: missing");
    expect(parseCalls).toHaveLength(0);
  });

  it("rejects an artifact whose content is not a base64 data URL", async () => {
    const db = makeDb([
      [{ id: "art_2", title: "note", content: "just some text" }],
    ]);
    const run = handler({ ...BASE, db });
    await expect(
      run({ artifactId: "art_2" }, new AbortController().signal),
    ).rejects.toThrow("not a parseable file");
    expect(parseCalls).toHaveLength(0);
  });

  it("requires an artifactId", async () => {
    const db = makeDb([]);
    const run = handler({ ...BASE, db });
    await expect(run({}, new AbortController().signal)).rejects.toThrow(
      "artifactId is required",
    );
  });
});
