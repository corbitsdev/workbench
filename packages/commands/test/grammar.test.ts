import { describe, expect, test } from "bun:test";
import { parseAtCommand, parseSlashCommand } from "../src/grammar";

describe("parseSlashCommand", () => {
  test("splits name from the raw remainder at the first space", () => {
    expect(parseSlashCommand("/echo hello world")).toEqual({
      name: "echo",
      args: "hello world",
    });
  });

  test("a bare name with no space carries empty args", () => {
    expect(parseSlashCommand("/echo")).toEqual({ name: "echo", args: "" });
  });

  test("trims leading whitespace off the raw remainder", () => {
    expect(parseSlashCommand("/echo   padded")).toEqual({
      name: "echo",
      args: "padded",
    });
  });

  test("does not tokenize the remainder beyond the first space", () => {
    expect(parseSlashCommand("/echo a b  c")).toEqual({
      name: "echo",
      args: "a b  c",
    });
  });

  test("undefined for text without a leading slash", () => {
    expect(parseSlashCommand("echo hello")).toBeUndefined();
  });

  test("undefined for a bare slash with no name", () => {
    expect(parseSlashCommand("/")).toBeUndefined();
    expect(parseSlashCommand("/ hello")).toBeUndefined();
  });

  test("undefined for a path-shaped leading slash — never swallows a plain message that happens to start with '/'", () => {
    expect(parseSlashCommand("/usr/local/bin")).toBeUndefined();
    expect(parseSlashCommand("/usr/local/bin is on my PATH")).toBeUndefined();
  });

  test("still parses a hyphenated command name", () => {
    expect(parseSlashCommand("/code-reviewer take a look")).toEqual({
      name: "code-reviewer",
      args: "take a look",
    });
  });
});

describe("parseAtCommand", () => {
  test("splits an @-prefixed name from its remainder identically", () => {
    expect(parseAtCommand("@echo hello world")).toEqual({
      name: "echo",
      args: "hello world",
    });
  });

  test("undefined for text without a leading @", () => {
    expect(parseAtCommand("/echo hello")).toBeUndefined();
  });
});
