import { describe, expect, test } from "bun:test";

import {
  deployablePackageFromBody,
  isFiveFieldCron,
  isPackageRejection,
  resolveMessagePackage,
} from "./deployable-package";

const PACKAGE_JSON = `{"name": "echo", "version": "1.0.0"}`;
const DEFINITION_JSON = `{"name": "Echo", "systemPrompt": "Echo back what you hear."}`;

describe("deployablePackageFromBody", () => {
  test("reads a package from two labelled fenced blocks and strips them", () => {
    const body =
      `Here's the agent.\n\npackage.json\n\`\`\`\n${PACKAGE_JSON}\n\`\`\`\n\n` +
      `definition.json\n\`\`\`\n${DEFINITION_JSON}\n\`\`\`\n\nPress Deploy.`;
    const result = deployablePackageFromBody(body);
    expect(isPackageRejection(result?.outcome ?? null)).toBe(false);
    expect(result?.outcome && "name" in result.outcome ? result.outcome.name : null).toBe("Echo");
    expect(result?.strippedBody).toBe("Here's the agent.\n\nPress Deploy.");
  });

  test("matches an info-string label instead of a preceding line", () => {
    const body = `\`\`\`json package.json\n${PACKAGE_JSON}\n\`\`\`\n\`\`\`definition.json\n${DEFINITION_JSON}\n\`\`\``;
    const result = deployablePackageFromBody(body);
    expect(result?.outcome && "name" in result.outcome ? result.outcome.name : null).toBe("Echo");
  });

  test("reads a comment label with a path prefix on the fence's first line", () => {
    const body =
      `Here is the package:\n\n\`\`\`json\n// Scribe/definition.json\n${DEFINITION_JSON}\n\`\`\`\n\n` +
      `\`\`\`json\n# Scribe/package.json\n${PACKAGE_JSON}\n\`\`\`\n\nPress Deploy.`;
    const result = deployablePackageFromBody(body);
    expect(result?.outcome && "name" in result.outcome ? result.outcome.name : null).toBe("Echo");
    expect(result?.strippedBody).toBe("Here is the package:\n\nPress Deploy.");
  });

  test("reads a bare filename on the fence's first line", () => {
    const body =
      `\`\`\`json\npackage.json\n${PACKAGE_JSON}\n\`\`\`\n\n` +
      `\`\`\`json\ndefinition.json\n${DEFINITION_JSON}\n\`\`\``;
    const result = deployablePackageFromBody(body);
    expect(result?.outcome && "name" in result.outcome ? result.outcome.name : null).toBe("Echo");
  });

  test("is null when only one of the two files is present", () => {
    const body = `package.json\n\`\`\`\n${PACKAGE_JSON}\n\`\`\``;
    expect(deployablePackageFromBody(body)).toBeNull();
  });

  test("rejects with a named field when the definition block fails validation", () => {
    const body =
      `package.json\n\`\`\`\n${PACKAGE_JSON}\n\`\`\`\n` +
      `definition.json\n\`\`\`\n{"systemPrompt": ""}\n\`\`\``;
    const result = deployablePackageFromBody(body);
    expect(isPackageRejection(result?.outcome ?? null)).toBe(true);
    expect(result?.outcome && "reason" in result.outcome ? result.outcome.reason : null).toBe(
      "definition.json is missing systemPrompt",
    );
  });

  test("rejects with a plain-words reason when definition.json isn't valid JSON", () => {
    const body =
      `package.json\n\`\`\`\n${PACKAGE_JSON}\n\`\`\`\n` +
      `definition.json\n\`\`\`\nnot json\n\`\`\``;
    const result = deployablePackageFromBody(body);
    expect(result?.outcome && "reason" in result.outcome ? result.outcome.reason : null).toBe(
      "definition.json is not valid JSON",
    );
  });

  test("takes name from package.json when definition.json omits it", () => {
    const body =
      `package.json\n\`\`\`\n${PACKAGE_JSON}\n\`\`\`\n` +
      `definition.json\n\`\`\`\n{"systemPrompt": "Echo back what you hear."}\n\`\`\``;
    const result = deployablePackageFromBody(body);
    expect(result?.outcome && "name" in result.outcome ? result.outcome.name : null).toBe("echo");
  });

  test("ignores an unknown extra field in definition.json", () => {
    const body =
      `package.json\n\`\`\`\n${PACKAGE_JSON}\n\`\`\`\n` +
      `definition.json\n\`\`\`\n${JSON.stringify({
        name: "Echo",
        systemPrompt: "Echo back what you hear.",
        type: "workflow",
      })}\n\`\`\``;
    const result = deployablePackageFromBody(body);
    expect(isPackageRejection(result?.outcome ?? null)).toBe(false);
    expect(result?.outcome && "name" in result.outcome ? result.outcome.name : null).toBe("Echo");
  });

  test("passes mcpHandles through trimmed, dropping empties", () => {
    const body =
      `package.json\n\`\`\`\n${PACKAGE_JSON}\n\`\`\`\n` +
      `definition.json\n\`\`\`\n${JSON.stringify({
        name: "Echo",
        systemPrompt: "Echo back what you hear.",
        mcpHandles: ["linear", " exa ", ""],
      })}\n\`\`\``;
    const result = deployablePackageFromBody(body);
    expect(isPackageRejection(result?.outcome ?? null)).toBe(false);
    expect(
      result?.outcome && "mcpHandles" in result.outcome ? result.outcome.mcpHandles : null,
    ).toEqual(["linear", "exa"]);
  });

  test("omits mcpHandles when definition.json doesn't name it", () => {
    const body =
      `package.json\n\`\`\`\n${PACKAGE_JSON}\n\`\`\`\n` +
      `definition.json\n\`\`\`\n${DEFINITION_JSON}\n\`\`\``;
    const result = deployablePackageFromBody(body);
    expect(isPackageRejection(result?.outcome ?? null)).toBe(false);
    expect(
      result?.outcome && "mcpHandles" in result.outcome ? result.outcome.mcpHandles : "absent",
    ).toBe("absent");
  });

  test("rejects with a plain-words reason when mcpHandles isn't a string array", () => {
    const body =
      `package.json\n\`\`\`\n${PACKAGE_JSON}\n\`\`\`\n` +
      `definition.json\n\`\`\`\n${JSON.stringify({
        name: "Echo",
        systemPrompt: "Echo back what you hear.",
        mcpHandles: "linear",
      })}\n\`\`\``;
    const result = deployablePackageFromBody(body);
    expect(isPackageRejection(result?.outcome ?? null)).toBe(true);
    expect(result?.outcome && "reason" in result.outcome ? result.outcome.reason : null).toBe(
      "definition.json's mcpHandles must be an array (was string)",
    );
  });
});

describe("isFiveFieldCron", () => {
  test("accepts exactly five whitespace-separated fields", () => {
    expect(isFiveFieldCron("0 9 * * *")).toBe(true);
    expect(isFiveFieldCron("  */5   *  *  *  *  ")).toBe(true);
  });

  test("rejects anything else", () => {
    expect(isFiveFieldCron("not a cron")).toBe(false);
    expect(isFiveFieldCron("* * * *")).toBe(false);
    expect(isFiveFieldCron("* * * * * *")).toBe(false);
  });
});

describe("resolveMessagePackage", () => {
  test("falls back to the body when there are no attachments", () => {
    const body = `package.json\n\`\`\`\n${PACKAGE_JSON}\n\`\`\`\ndefinition.json\n\`\`\`\n${DEFINITION_JSON}\n\`\`\``;
    const { pkg, renderedBody } = resolveMessagePackage([], body);
    expect(pkg && "name" in pkg ? pkg.name : null).toBe("Echo");
    expect(renderedBody).toBe("");
  });

  test("prefers attachments over a body that also carries fenced blocks", () => {
    const body = `package.json\n\`\`\`\n${PACKAGE_JSON}\n\`\`\`\ndefinition.json\n\`\`\`\n${DEFINITION_JSON}\n\`\`\``;
    const { pkg, renderedBody } = resolveMessagePackage(
      [
        { name: "package.json", contentType: "application/json", text: PACKAGE_JSON },
        {
          name: "definition.json",
          contentType: "application/json",
          text: `{"name": "Attached", "systemPrompt": "hi"}`,
        },
      ],
      body,
    );
    expect(pkg && "name" in pkg ? pkg.name : null).toBe("Attached");
    expect(renderedBody).toBe(body);
  });

  test("surfaces a rejection from attachments naming the missing field", () => {
    const { pkg } = resolveMessagePackage(
      [
        { name: "package.json", contentType: "application/json", text: PACKAGE_JSON },
        {
          name: "definition.json",
          contentType: "application/json",
          text: `{"name": "Attached"}`,
        },
      ],
      "unused body",
    );
    expect(isPackageRejection(pkg)).toBe(true);
    expect(pkg && "reason" in pkg ? pkg.reason : null).toBe(
      "definition.json is missing systemPrompt",
    );
  });
});
