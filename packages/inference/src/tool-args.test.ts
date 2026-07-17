import { describe, test, expect } from "bun:test";

import {
  parseCompletedToolArgs,
  sanitizeToolArgsForHistory,
  unwrapRawToolArgs,
} from "./tool-args";

const DEPLOY_ARGS = {
  projectName: "corbits-vpc",
  filePath: "index.html",
  html: "<!DOCTYPE html><html lang='en'><head><title>Corbits VPC</title></head><body>hi</body></html>",
};

describe("parseCompletedToolArgs — approval-loop regression", () => {
  test("parses a well-formed buffer", () => {
    expect(parseCompletedToolArgs(JSON.stringify(DEPLOY_ARGS))).toEqual(
      DEPLOY_ARGS,
    );
  });

  test("empty buffer yields empty object", () => {
    expect(parseCompletedToolArgs("")).toEqual({});
    expect(parseCompletedToolArgs("   ")).toEqual({});
  });

  test("unwraps model-emitted {_raw: <stringified JSON>} arguments", () => {
    const buffer = JSON.stringify({ _raw: JSON.stringify(DEPLOY_ARGS) });
    expect(parseCompletedToolArgs(buffer)).toEqual(DEPLOY_ARGS);
  });

  test("recovers a double-encoded JSON string buffer", () => {
    const buffer = JSON.stringify(JSON.stringify(DEPLOY_ARGS));
    expect(parseCompletedToolArgs(buffer)).toEqual(DEPLOY_ARGS);
  });

  test("salvages the first object from duplicated concatenated deltas", () => {
    const one = JSON.stringify(DEPLOY_ARGS);
    expect(parseCompletedToolArgs(one + one)).toEqual(DEPLOY_ARGS);
  });

  test("salvage respects braces inside string values", () => {
    const args = { html: 'if (x) { return "}" }', filePath: "a.html" };
    const one = JSON.stringify(args);
    expect(parseCompletedToolArgs(one + one)).toEqual(args);
  });

  test("keeps _raw when the inner string is not valid JSON", () => {
    const buffer = JSON.stringify({ _raw: "not json at all" });
    expect(parseCompletedToolArgs(buffer)).toEqual({
      _raw: "not json at all",
    });
  });

  test("genuinely unparseable buffer falls back to {_raw: buffer}", () => {
    expect(parseCompletedToolArgs("{broken")).toEqual({ _raw: "{broken" });
  });

  test("does not unwrap when _raw sits beside other keys", () => {
    const args = { _raw: JSON.stringify(DEPLOY_ARGS), target: "preview" };
    expect(parseCompletedToolArgs(JSON.stringify(args))).toEqual(args);
  });

  test("non-object JSON (array, number) yields empty object", () => {
    expect(parseCompletedToolArgs("[1,2]")).toEqual({});
    expect(parseCompletedToolArgs("42")).toEqual({});
  });
});

describe("unwrapRawToolArgs — history re-serialization guard", () => {
  test("unwraps stored {_raw} arguments so the model never sees the shape", () => {
    expect(unwrapRawToolArgs({ _raw: JSON.stringify(DEPLOY_ARGS) })).toEqual(
      DEPLOY_ARGS,
    );
  });

  test("passes through normal arguments untouched", () => {
    expect(unwrapRawToolArgs(DEPLOY_ARGS)).toEqual(DEPLOY_ARGS);
  });

  test("keeps unrecoverable _raw unchanged (parse-time caller decides)", () => {
    expect(unwrapRawToolArgs({ _raw: "{broken" })).toEqual({
      _raw: "{broken",
    });
  });
});

describe("sanitizeToolArgsForHistory", () => {
  test("unwraps recoverable _raw before re-serialization to the provider", () => {
    expect(
      sanitizeToolArgsForHistory({ _raw: JSON.stringify(DEPLOY_ARGS) }),
    ).toEqual(DEPLOY_ARGS);
  });

  test("strips unrecoverable _raw to {} so the model never sees the shape", () => {
    expect(sanitizeToolArgsForHistory({ _raw: "{broken" })).toEqual({});
  });

  test("passes through normal arguments untouched", () => {
    expect(sanitizeToolArgsForHistory(DEPLOY_ARGS)).toEqual(DEPLOY_ARGS);
  });
});
