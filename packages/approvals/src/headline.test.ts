import { describe, expect, test } from "bun:test";
import { argumentsSummaryFor, headlineFor } from "./headline";

function writeFileDefinition(): { name: string; description: string } {
  return { name: "write_file", description: "Write a file" };
}

describe("argumentsSummaryFor write_file preview", () => {
  test("redacts a secret-like string in the content preview", () => {
    const summary = argumentsSummaryFor(writeFileDefinition(), {
      path: "/tmp/creds.json",
      content: "api_key sk-abcdefgh12345678 value",
    });
    expect(summary).toContain("[redacted]");
    expect(summary).not.toContain("sk-abcdefgh12345678");
  });

  test("leaves non-secret content unchanged", () => {
    const summary = argumentsSummaryFor(writeFileDefinition(), {
      path: "/tmp/hello.txt",
      content: "hello world",
    });
    expect(summary).toBe('/tmp/hello.txt: "hello world"');
  });
});

describe("generic tool argument rendering", () => {
  function genericDefinition(): { name: string; description: string } {
    return { name: "run_command", description: "Run a shell command" };
  }

  test("redacts a secret-like value in a generic tool's argument list", () => {
    const summary = argumentsSummaryFor(genericDefinition(), {
      command: "deploy",
      target: "pk-live-ABCDEFGH12345678",
    });
    expect(summary).toContain("target: [redacted]");
    expect(summary).not.toContain("ABCDEFGH12345678");
  });

  test("redacts a secret inside a generic tool's title", () => {
    const headline = headlineFor(genericDefinition(), {
      title: "using pk-live-ABCDEFGH12345678 token",
    });
    expect(headline).toContain("[redacted]");
    expect(headline).not.toContain("ABCDEFGH12345678");
  });

  test("redacts a top-level password-key value with no secret prefix", () => {
    const summary = argumentsSummaryFor(genericDefinition(), {
      host: "localhost",
      password: "supersecretvalue123",
    });
    expect(summary).toContain("password: [redacted]");
    expect(summary).not.toContain("supersecretvalue123");
  });

  test("redacts a free-form keyword+space secret in the title", () => {
    const headline = headlineFor(genericDefinition(), {
      title: "use password supersecret123 here",
    });
    expect(headline).toContain("[redacted]");
    expect(headline).not.toContain("supersecret123");
  });

  test("redacts a password-keyed secret nested inside a JSON value object", () => {
    const summary = argumentsSummaryFor(genericDefinition(), {
      config: { password: "hunter2-hunter2", host: "localhost" },
    });
    expect(summary).toContain('"password":"[redacted]"');
    expect(summary).not.toContain("hunter2-hunter2");
  });

  test("redacts a password-keyed secret inside a JSON-stringified object value", () => {
    const summary = argumentsSummaryFor(genericDefinition(), {
      config: JSON.stringify({ password: "hunter2-hunter2", host: "localhost" }),
    });
    expect(summary).toContain('"password":"[redacted]"');
    expect(summary).not.toContain("hunter2-hunter2");
  });

  test("leaves a benign generic value unchanged", () => {
    const summary = argumentsSummaryFor(genericDefinition(), {
      host: "localhost",
      port: 5432,
    });
    expect(summary).toContain("host: localhost");
    expect(summary).toContain("port: 5432");
    expect(summary).not.toContain("[redacted]");
  });
});
