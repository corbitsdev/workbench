import { describe, expect, test } from "bun:test";
import { argumentsSummaryFor, headlineFor } from "./headline";

// Like redact.test.ts, the provider-key fixtures here are stamped at runtime
// from benign parts so no full credential-shaped string exists contiguously at
// rest (GitHub secret-scanning blocks pushes carrying one), while the runtime
// value is exactly the real-world format the redactor must catch.
const anthropicKey = (): string => `${["sk", "ant", "api03"].join("-")}-${"9x8Y7z6W5v4U3t2S1r0Q"}`;
const svcacctKey = (): string => `${["sk", "svcacct"].join("-")}-${"AbCdEf1234567890xYzWv"}`;

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

  test("redact-then-truncate: an Anthropic key in a long content is redacted, not leaked", () => {
    // The content is long enough to truncate, and the Anthropic key sits near
    // the 120-char preview boundary. The seam must redact the full content
    // first (key -> [redacted]) and only then truncate; redacting a truncated
    // preview of a long content is how a key straddling the boundary leaks.
    const key = anthropicKey();
    const content = `${"M".repeat(100)} ${key} ${"N".repeat(300)}`;
    const summary = argumentsSummaryFor(writeFileDefinition(), {
      path: "/tmp/creds.json",
      content,
    });
    expect(summary).not.toContain("sk-ant");
    expect(summary).toContain("[redacted]");
  });
});

describe("workflow_deploy headline redaction", () => {
  function workflowDefinition(): { name: string; description: string } {
    return { name: "workflow_deploy", description: "Deploy a workflow" };
  }

  test("redacts a secret-shaped packageName in the headline", () => {
    const key = anthropicKey();
    const headline = headlineFor(workflowDefinition(), {
      packageName: key,
      commitSha: "0123456789abcdef",
      toolPackagePins: [],
    });
    expect(headline).toContain("[redacted]");
    expect(headline).not.toContain("sk-ant");
  });

  test("redacts a secret-shaped toolPackagePins name in the headline", () => {
    const key = svcacctKey();
    const headline = headlineFor(workflowDefinition(), {
      packageName: "my-pkg",
      commitSha: "0123456789abcdef",
      toolPackagePins: [{ name: key, version: "1.0.0" }],
    });
    expect(headline).toContain("[redacted]");
    expect(headline).not.toContain(key);
  });

  test("keeps an ordinary workflow headline unchanged", () => {
    const headline = headlineFor(workflowDefinition(), {
      packageName: "checkout",
      commitSha: "0123456789abcdef",
      toolPackagePins: [{ name: "gh", version: "2.0.0" }],
    });
    expect(headline).toBe("Deploy workflow checkout @ 0123456 — tools: gh@2.0.0");
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

  test("redacts a runtime-assembled provider key in the title", () => {
    const key = anthropicKey();
    const headline = headlineFor(genericDefinition(), {
      title: `using ${key}`,
    });
    expect(headline).toContain("[redacted]");
    expect(headline).not.toContain(key);
  });

  test("redacts provider-key-shaped JSON-in-title structurally", () => {
    const headline = headlineFor(genericDefinition(), {
      title: JSON.stringify({ password: "hunter2-hunter2", host: "localhost" }),
    });
    expect(headline).not.toContain("hunter2-hunter2");
    expect(headline).toContain("[redacted]");
  });

  test("redacts a password-keyed value inside a generic title that is not JSON", () => {
    const headline = headlineFor(genericDefinition(), {
      title: "password=supersecretvalue123 please",
    });
    expect(headline).toContain("[redacted]");
    expect(headline).not.toContain("supersecretvalue123");
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
    expect(summary).not.toContain("hunter2-hunter2");
    expect(summary).toContain("[redacted]");
  });

  test("redacts a password-keyed secret inside a JSON-stringified object value", () => {
    const summary = argumentsSummaryFor(genericDefinition(), {
      config: JSON.stringify({ password: "hunter2-hunter2", host: "localhost" }),
    });
    expect(summary).not.toContain("hunter2-hunter2");
    expect(summary).toContain("[redacted]");
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
