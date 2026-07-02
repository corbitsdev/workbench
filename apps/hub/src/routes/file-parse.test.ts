/// <reference types="bun" />
import { describe, expect, it, mock, beforeEach } from "bun:test";
import { Hono } from "hono";

type Row = Record<string, unknown>;

let instanceRow: Row | undefined;
let ownershipRow: Row | undefined;
let parseImpl: (input: unknown) => Promise<string>;
const insertedArtifacts: Row[] = [];

class FakeFileParseError extends Error {}

mock.module("../services/file-parser", () => ({
  parseDocument: (_db: unknown, input: unknown) => parseImpl(input),
  FileParseError: FakeFileParseError,
}));

mock.module("../lib/user-context", () => ({
  getRequestedUserContext: () =>
    Promise.resolve({
      context: { tenantId: "tnt_1", principalId: "prn_user" },
      forbidden: false,
    }),
}));

const { createFileParseRouter } = await import("./file-parse");

function makeDb() {
  return {
    query: {
      agentInstance: { findFirst: () => Promise.resolve(instanceRow) },
      memberAgentInstance: { findFirst: () => Promise.resolve(ownershipRow) },
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        insert: (_table: unknown) => ({
          values: (v: Row) => {
            // Only capture the artifact row (it carries `kind`), not the version row.
            if ("kind" in v) insertedArtifacts.push(v);
            return Promise.resolve();
          },
        }),
      };
      return fn(tx);
    },
  };
}

function app() {
  const a = new Hono<{ Variables: { userId: string } }>();
  a.use("*", async (c, next) => {
    c.set("userId", "usr_1");
    await next();
  });
  a.route("/", createFileParseRouter(makeDb() as never));
  return a;
}

async function post(body: unknown) {
  return app().request("/instances/inst_1/parse-file", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// "SGVsbG8=" is base64 for "Hello".
const OK_BODY = {
  filename: "report.pdf",
  mimeType: "application/pdf",
  data: "SGVsbG8=",
};

describe("POST /instances/:instanceId/parse-file (CL-2628)", () => {
  beforeEach(() => {
    instanceRow = { id: "inst_1", tenantId: "tnt_1" };
    ownershipRow = { id: "mai_1" };
    parseImpl = () => Promise.resolve("PARSED TEXT");
    insertedArtifacts.length = 0;
  });

  it("parses then stores, returning the artifact id and text", async () => {
    const res = await post(OK_BODY);
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      artifactId: string;
      parsedText: string;
    };
    expect(json.parsedText).toBe("PARSED TEXT");
    // Stored exactly once, after a successful parse, keyed to the returned id.
    expect(insertedArtifacts).toHaveLength(1);
    expect(insertedArtifacts[0]!.id).toBe(json.artifactId);
    expect(insertedArtifacts[0]!.content).toBe(
      "data:application/pdf;base64,SGVsbG8=",
    );
  });

  it("normalizes a parameterized MIME type before storing (F3 regression)", async () => {
    const res = await post({
      ...OK_BODY,
      mimeType: "application/pdf;charset=utf-8",
    });
    expect(res.status).toBe(201);
    // The stored data URL uses the bare type, so parse_file's decode round-trips.
    expect(insertedArtifacts[0]!.content).toBe(
      "data:application/pdf;base64,SGVsbG8=",
    );
  });

  it("rejects an unsupported document type with 415", async () => {
    const res = await post({ ...OK_BODY, mimeType: "application/zip" });
    expect(res.status).toBe(415);
    expect(insertedArtifacts).toHaveLength(0);
  });

  it("rejects invalid base64 with 400", async () => {
    const res = await post({ ...OK_BODY, data: "!!!not-base64!!!" });
    expect(res.status).toBe(400);
    expect(insertedArtifacts).toHaveLength(0);
  });

  it("rejects a caller who does not own the instance with 403", async () => {
    ownershipRow = undefined;
    const res = await post(OK_BODY);
    expect(res.status).toBe(403);
    expect(insertedArtifacts).toHaveLength(0);
  });

  it("returns 404 when the instance does not exist", async () => {
    instanceRow = undefined;
    const res = await post(OK_BODY);
    expect(res.status).toBe(404);
  });

  it("returns 502 and stores nothing when the parse fails", async () => {
    parseImpl = () => Promise.reject(new FakeFileParseError("bad pdf"));
    const res = await post(OK_BODY);
    expect(res.status).toBe(502);
    expect(insertedArtifacts).toHaveLength(0);
  });
});
